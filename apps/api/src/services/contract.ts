import { eq, inArray } from 'drizzle-orm';
import { decodeEventLog, type Abi, type AbiEvent, type Hex } from 'viem';
import {
  EIP1822_PROXIABLE_SLOT,
  ERC1967_ADMIN_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  ERC721_INTERFACE_ID,
  erc20Abi,
  erc721ProbeAbi,
  MULTICALL3_ADDRESS,
} from '@4663scan/shared/abi';
import {
  addressLabels,
  blocks,
  contractSources,
  transactions,
  type ContractSourceRow,
} from '@4663scan/shared/db/schema';
import { bufToHex, hexToBuf } from '@4663scan/shared/db/hex-bytea';
import type {
  ContractEventLog,
  ContractInfo,
  ContractProxyInfo,
  ContractReadResult,
  ContractSource,
  DecodedParam,
  DecodedSelectorInfo,
} from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import { TtlMap, dedupe } from '../lib/ttl.js';
import { asHex } from '../lib/params.js';
import type { Decode } from './decode.js';
import type { Meta } from './labels.js';

/**
 * Negative-cache TTL for "not verified" — short relative to
 * method_signatures' 7 days (docs/architecture.md-style precedent): a
 * contract's own developer commonly verifies it within hours of deploying,
 * unlike a method signature entering openchain's shared database, so a
 * visitor re-checking soon after deploy should see it land reasonably fast.
 */
const SOURCE_RECHECK_MS = 60 * 60 * 1000;
const SOURCE_FETCH_TIMEOUT_MS = 5_000;
/** eth_getCode/proxy-slot reads are effectively immutable; cache briefly to
 *  avoid redundant RPC on Code/Read/Events tab navigation for one address. */
const CODE_CACHE_MS = 30_000;
const PROXY_CACHE_MS = 30_000;
/** Bounds the PUSH4 selector scan on unverified bytecode. */
const MAX_SCANNED_SELECTORS = 64;

interface VerifiedFetch {
  name: string | null;
  compilerVersion: string | null;
  compilerSettings: unknown | null;
  abi: unknown[] | null;
  sourceFiles: { path: string; content: string }[] | null;
  provider: 'sourcify' | 'blockscout';
}
type SourceOutcome = VerifiedFetch | 'not-found' | 'error';

interface SourcifyResponse {
  match: string | null;
  compilation?: {
    name?: string | null;
    compilerVersion?: string | null;
    compilerSettings?: unknown;
  };
  abi?: unknown[] | null;
  sources?: Record<string, { content: string }>;
}

interface BlockscoutResponse {
  is_verified?: boolean;
  name?: string | null;
  compiler_version?: string | null;
  compiler_settings?: unknown;
  abi?: unknown[] | null;
  source_code?: string | null;
  file_path?: string | null;
  additional_sources?: { file_path: string; source_code: string }[];
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(stringifyOutput));
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function rowToSource(row: ContractSourceRow): ContractSource {
  return {
    verified: row.verified,
    name: row.name,
    compilerVersion: row.compilerVersion,
    compilerSettings: row.compilerSettings,
    abi: (row.abi as unknown[] | null) ?? null,
    files: (row.sourceFiles as { path: string; content: string }[] | null) ?? null,
    provider: (row.provider as 'sourcify' | 'blockscout' | null) ?? null,
  };
}

const EMPTY_SOURCE: ContractSource = {
  verified: false,
  name: null,
  compilerVersion: null,
  compilerSettings: null,
  abi: null,
  files: null,
  provider: null,
};

export function makeContract(ctx: AppContext, meta: Meta, decode: Decode) {
  const codeCache = new TtlMap<
    string,
    { isContract: boolean; codeSize: number; bytecode: string }
  >(CODE_CACHE_MS, 2000);
  const proxyCache = new TtlMap<string, ContractProxyInfo | null>(PROXY_CACHE_MS, 2000);

  async function getCodeInfo(
    address: string,
  ): Promise<{ isContract: boolean; codeSize: number; bytecode: string }> {
    const hit = codeCache.get(address);
    if (hit) return hit;
    return dedupe(`contract:code:${address}`, async () => {
      const code = await ctx.client.getCode({ address: asHex(address) });
      const bytecode = code ?? '0x';
      const info = {
        isContract: bytecode !== '0x',
        codeSize: (bytecode.length - 2) / 2,
        bytecode,
      };
      codeCache.set(address, info);
      return info;
    });
  }

  /** null-out an all-zero slot value; last 20 bytes are the stored address. */
  function slotToAddress(slot: string): string | null {
    const hex = slot.startsWith('0x') ? slot.slice(2) : slot;
    const tail = hex.slice(-40);
    return /^0+$/.test(tail) ? null : `0x${tail}`;
  }

  async function detectProxy(address: string): Promise<ContractProxyInfo | null> {
    const hit = proxyCache.get(address);
    if (hit !== undefined) return hit;
    return dedupe(`contract:proxy:${address}`, async () => {
      const addr = asHex(address);
      const [impl1967, admin1967, proxiable] = await Promise.all([
        ctx.client.getStorageAt({ address: addr, slot: ERC1967_IMPLEMENTATION_SLOT as `0x${string}` }),
        ctx.client.getStorageAt({ address: addr, slot: ERC1967_ADMIN_SLOT as `0x${string}` }),
        ctx.client.getStorageAt({ address: addr, slot: EIP1822_PROXIABLE_SLOT as `0x${string}` }),
      ]);
      let result: ContractProxyInfo | null = null;
      const impl = impl1967 ? slotToAddress(impl1967) : null;
      if (impl) {
        result = { standard: 'eip1967', implementation: impl, admin: admin1967 ? slotToAddress(admin1967) : null };
      } else {
        const proxiableImpl = proxiable ? slotToAddress(proxiable) : null;
        if (proxiableImpl) result = { standard: 'eip1822', implementation: proxiableImpl, admin: null };
      }
      proxyCache.set(address, result);
      return result;
    });
  }

  /** Cheaply derived from our own indexed history; null if the deployment
   *  tx isn't in the indexed range — never an expensive on-chain scan. */
  async function findCreator(
    address: string,
  ): Promise<{ address: string; txHash: string } | null> {
    const rows = await ctx.db
      .select({ from: transactions.from, hash: transactions.hash })
      .from(transactions)
      .where(eq(transactions.contractAddress, address))
      .limit(1);
    const row = rows[0];
    return row ? { address: row.from, txHash: row.hash } : null;
  }

  async function detectToken(
    address: string,
  ): Promise<{ tokenType: 'erc20' | 'erc721' | null; token: ContractInfo['token'] }> {
    const addr = asHex(address);
    let is721 = false;
    try {
      is721 = await ctx.client.readContract({
        address: addr,
        abi: erc721ProbeAbi,
        functionName: 'supportsInterface',
        args: [ERC721_INTERFACE_ID as `0x${string}`],
      });
    } catch {
      is721 = false;
    }
    if (is721) {
      const [name, symbol] = await Promise.allSettled([
        ctx.client.readContract({ address: addr, abi: erc721ProbeAbi, functionName: 'name' }),
        ctx.client.readContract({ address: addr, abi: erc721ProbeAbi, functionName: 'symbol' }),
      ]);
      return {
        tokenType: 'erc721',
        token: {
          address,
          name: name.status === 'fulfilled' ? name.value : null,
          symbol: symbol.status === 'fulfilled' ? symbol.value : null,
          decimals: null,
          isStockToken: false,
        },
      };
    }

    // Prefer metadata our own token worker already discovered; only probe
    // live for tokens it hasn't seen yet (e.g. never transferred).
    const known = (await meta.resolveTokenRefs([address])).get(address);
    if (known) return { tokenType: 'erc20', token: known };

    try {
      const results = await ctx.client.multicall({
        allowFailure: true,
        multicallAddress: asHex(MULTICALL3_ADDRESS),
        contracts: [
          { address: addr, abi: erc20Abi, functionName: 'decimals' },
          { address: addr, abi: erc20Abi, functionName: 'symbol' },
          { address: addr, abi: erc20Abi, functionName: 'name' },
          { address: addr, abi: erc20Abi, functionName: 'totalSupply' },
        ],
      });
      const [dec, sym, name, supply] = results;
      if (dec?.status !== 'success' || supply?.status !== 'success') {
        return { tokenType: null, token: null };
      }
      return {
        tokenType: 'erc20',
        token: {
          address,
          name: name?.status === 'success' ? (name.result as string) : null,
          symbol: sym?.status === 'success' ? (sym.result as string) : null,
          decimals: Number(dec.result),
          isStockToken: false,
        },
      };
    } catch {
      return { tokenType: null, token: null };
    }
  }

  async function fetchSourcify(address: string): Promise<SourceOutcome> {
    try {
      const res = await fetch(
        `https://sourcify.dev/server/v2/contract/${ctx.env.CHAIN_ID}/${address}?fields=compilation,abi,sources`,
        { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) },
      );
      if (res.status === 404) return 'not-found';
      if (!res.ok) return 'error';
      const body = (await res.json()) as SourcifyResponse;
      if (!body.match) return 'not-found';
      const sourceFiles = body.sources
        ? Object.entries(body.sources).map(([path, v]) => ({ path, content: v.content }))
        : null;
      return {
        name: body.compilation?.name ?? null,
        compilerVersion: body.compilation?.compilerVersion ?? null,
        compilerSettings: body.compilation?.compilerSettings ?? null,
        abi: body.abi ?? null,
        sourceFiles,
        provider: 'sourcify',
      };
    } catch {
      return 'error';
    }
  }

  async function fetchBlockscout(address: string): Promise<SourceOutcome> {
    try {
      const res = await fetch(
        `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${address}`,
        { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) },
      );
      if (res.status === 404) return 'not-found';
      if (!res.ok) return 'error';
      const body = (await res.json()) as BlockscoutResponse;
      if (!body.is_verified) return 'not-found';
      const sourceFiles: { path: string; content: string }[] = [];
      if (body.source_code) {
        sourceFiles.push({ path: body.file_path ?? 'Contract.sol', content: body.source_code });
      }
      for (const s of body.additional_sources ?? []) {
        sourceFiles.push({ path: s.file_path, content: s.source_code });
      }
      return {
        name: body.name ?? null,
        compilerVersion: body.compiler_version ?? null,
        compilerSettings: body.compiler_settings ?? null,
        abi: body.abi ?? null,
        sourceFiles: sourceFiles.length > 0 ? sourceFiles : null,
        provider: 'blockscout',
      };
    } catch {
      return 'error';
    }
  }

  /**
   * Tries Sourcify first, Blockscout only when Sourcify has no match — halves
   * upstream calls for the common (unverified) case instead of always
   * querying both. `conclusive: false` means at least one upstream check
   * failed transiently without the other finding a match — the caller must
   * not cache that as a negative (a later visit deserves a real re-check).
   */
  async function checkUpstream(
    address: string,
  ): Promise<{ found: VerifiedFetch | null; conclusive: boolean }> {
    const sc = await fetchSourcify(address);
    if (sc !== 'not-found' && sc !== 'error') return { found: sc, conclusive: true };
    const bs = await fetchBlockscout(address);
    if (bs !== 'not-found' && bs !== 'error') return { found: bs, conclusive: true };
    return { found: null, conclusive: sc === 'not-found' && bs === 'not-found' };
  }

  async function getVerifiedSource(address: string): Promise<ContractSource> {
    const rows = await ctx.db
      .select()
      .from(contractSources)
      .where(eq(contractSources.address, address))
      .limit(1);
    const row = rows[0];
    const staleNegative =
      row != null && !row.verified && row.checkedAt.getTime() < Date.now() - SOURCE_RECHECK_MS;
    if (row && !staleNegative) return rowToSource(row);

    const { found, conclusive } = await checkUpstream(address);
    if (!conclusive) {
      // Neither upstream check landed positive, and at least one errored:
      // degrade to whatever we already knew rather than caching a guess.
      return row ? rowToSource(row) : EMPTY_SOURCE;
    }
    const values = found
      ? {
          address,
          verified: true,
          name: found.name,
          compilerVersion: found.compilerVersion,
          compilerSettings: found.compilerSettings,
          abi: found.abi,
          sourceFiles: found.sourceFiles,
          provider: found.provider,
          checkedAt: new Date(),
        }
      : {
          address,
          verified: false,
          name: null,
          compilerVersion: null,
          compilerSettings: null,
          abi: null,
          sourceFiles: null,
          provider: null,
          checkedAt: new Date(),
        };
    await ctx.db
      .insert(contractSources)
      .values(values)
      .onConflictDoUpdate({ target: contractSources.address, set: values });
    return rowToSource(values as ContractSourceRow);
  }

  /**
   * Naive PUSH4 (0x63) scan over raw runtime bytecode — a well-known,
   * imprecise heuristic (embedded data can coincidentally look like a
   * PUSH4+selector) shared by other explorers' "unverified" views, not a
   * disassembler. Bounded and only used when there's no ABI to work from.
   */
  function scanSelectors(bytecode: string): string[] {
    const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
    const selectors = new Set<string>();
    for (let i = 0; i + 10 <= hex.length; i += 2) {
      if (hex.slice(i, i + 2) === '63') {
        selectors.add(`0x${hex.slice(i + 2, i + 10)}`);
        if (selectors.size >= MAX_SCANNED_SELECTORS) break;
      }
    }
    return [...selectors];
  }

  async function decodedSelectorsFor(bytecode: string): Promise<DecodedSelectorInfo[]> {
    const selectors = scanSelectors(bytecode);
    if (selectors.length === 0) return [];
    const names = await decode.resolveMethodNames(selectors);
    return selectors.map((selector) => ({
      selector,
      signature: null,
      name: names.get(selector) ?? null,
    }));
  }

  async function getContractInfo(address: string): Promise<ContractInfo> {
    const code = await getCodeInfo(address);
    if (!code.isContract) {
      return {
        isContract: false,
        codeSize: 0,
        bytecode: null,
        tokenType: null,
        token: null,
        proxy: null,
        creator: null,
        labels: [],
        source: EMPTY_SOURCE,
        decodedSelectors: null,
      };
    }

    const [proxy, creator, tokenInfo, labelRows] = await Promise.all([
      detectProxy(address),
      findCreator(address),
      detectToken(address),
      ctx.db
        .select({ label: addressLabels.label, category: addressLabels.category })
        .from(addressLabels)
        .where(eq(addressLabels.address, address)),
    ]);

    // Source/read/ABI target the IMPLEMENTATION for a proxy, the address
    // itself otherwise — per charter.
    const sourceTarget = proxy?.implementation ?? address;
    const source = await getVerifiedSource(sourceTarget);

    const decodedSelectors = source.verified ? null : await decodedSelectorsFor(code.bytecode);

    return {
      isContract: true,
      codeSize: code.codeSize,
      bytecode: source.verified ? null : code.bytecode,
      tokenType: tokenInfo.tokenType,
      token: tokenInfo.token,
      proxy,
      creator,
      labels: labelRows,
      source,
      decodedSelectors,
    };
  }

  async function readFunction(
    address: string,
    abi: Abi,
    fnName: string,
    args: unknown[],
  ): Promise<ContractReadResult> {
    try {
      const result = await ctx.client.readContract({
        address: asHex(address),
        abi,
        functionName: fnName,
        args,
      });
      const outputs = Array.isArray(result)
        ? result.map(stringifyOutput)
        : [stringifyOutput(result)];
      return { success: true, outputs, error: null };
    } catch (err) {
      return {
        success: false,
        outputs: null,
        error: err instanceof Error ? err.message.slice(0, 300) : 'call failed',
      };
    }
  }

  function decodeLogWithAbi(
    abi: Abi,
    data: string,
    topics: string[],
  ): { name: string; params: DecodedParam[] } | null {
    if (topics.length === 0) return null;
    try {
      const result = decodeEventLog({
        abi,
        data: data as Hex,
        topics: topics as [Hex, ...Hex[]],
      });
      if (!result.eventName) return null;
      const eventName = result.eventName;
      const eventDef = abi.find(
        (e): e is AbiEvent => e.type === 'event' && e.name === eventName,
      );
      if (!eventDef) return { name: eventName, params: [] };
      const args = result.args as Record<string, unknown> | readonly unknown[] | undefined;
      const params: DecodedParam[] = eventDef.inputs.map((inp, i) => {
        const value = Array.isArray(args)
          ? args[i]
          : (args as Record<string, unknown> | undefined)?.[inp.name && inp.name.length > 0 ? inp.name : i];
        return {
          name: inp.name && inp.name.length > 0 ? inp.name : `arg${i}`,
          type: inp.type,
          value: stringifyOutput(value),
        };
      });
      return { name: eventName, params };
    } catch {
      return null;
    }
  }

  /**
   * Recent logs FOR this address (logs.address = the contract itself, not
   * logs it merely appears in as a topic) within the indexed window — the
   * logs table isn't retained forever for non-hot ranges, matching the rest
   * of this app's tiering story. Decoded when an ABI is available (the
   * caller resolves proxy-implementation source first); undecoded logs
   * still render with raw topics/data, same as the tx detail page.
   */
  interface LogRow {
    // Raw sql bypasses drizzle's bigint({mode:'number'}) column coercion —
    // postgres.js returns int8/bigint as strings by default (avoiding silent
    // precision loss), so this is cast to ::int in the query itself, same
    // convention as addresses.ts's countTxs. int4 comfortably covers this
    // chain's block numbers (~16M, nowhere near 2^31).
    block_number: number;
    log_index: number;
    tx_hash: Buffer;
    topic0: Buffer | null;
    topic1: Buffer | null;
    topic2: Buffer | null;
    topic3: Buffer | null;
    data: Buffer;
  }

  async function getEvents(
    address: string,
    limit: number,
    cursor: [number, number] | null,
    abi: unknown[] | null,
  ): Promise<{ items: ContractEventLog[]; nextCursor: string | null }> {
    // `logs` is address-indexed (logs_address_idx on (address, block_number))
    // but keyed (block_number, log_index) — a plain `WHERE address = $1
    // ORDER BY block_number DESC LIMIT N` lets Postgres choose a backward
    // scan of the PRIMARY KEY (satisfies ORDER BY for free) and filter rows
    // as it goes, betting enough matches turn up quickly. Verified live
    // (EXPLAIN ANALYZE against this exact table): for a low-activity
    // address that bet fails catastrophically — a near-full-table scan
    // (12s+, still running past a 10s statement_timeout) instead of the
    // selective address index. Plain MATERIALIZED alone overcorrects: it
    // forces the WHOLE address-filtered set to be evaluated before sorting,
    // which is fine for a rare address but pathological for a very active
    // one (millions of matching rows materialized just to take the top few).
    // Bounding the CTE's own ORDER BY + LIMIT (block_number DESC only, no
    // log_index — that's not in the index) gives Postgres a plan that's
    // cheap either way: a rare address forces the selective index (nothing
    // else can satisfy an order-by-limit that small), a hot address keeps
    // its fast backward-PK-scan-until-N-found plan. Padding the limit
    // beyond what's requested (rather than requesting exactly `limit`)
    // covers same-block-number ties the index can't sub-order by log_index
    // — 200 extra rows is far beyond any realistic same-block log count
    // from one contract, at negligible extra cost either way. Confirmed via
    // EXPLAIN ANALYZE: sub-3ms for both a zero-match and a 12M-match address.
    const TIE_PAD = 200;
    const addrBuf = hexToBuf(address);
    const cursorSql = cursor
      ? ctx.sql`and (block_number, log_index) < (${cursor[0]}, ${cursor[1]})`
      : ctx.sql``;
    const rows = await ctx.sql<LogRow[]>`
      with filtered as materialized (
        select block_number, log_index, tx_hash, topic0, topic1, topic2, topic3, data
        from logs
        where address = ${addrBuf} ${cursorSql}
        order by block_number desc
        limit ${limit + TIE_PAD}
      )
      select block_number::int as block_number, log_index, tx_hash,
             topic0, topic1, topic2, topic3, data
      from filtered
      order by block_number desc, log_index desc
      limit ${limit + 1}`;
    const page = rows.slice(0, limit).map((r) => ({
      blockNumber: r.block_number,
      logIndex: r.log_index,
      txHash: bufToHex(r.tx_hash),
      topic0: r.topic0 ? bufToHex(r.topic0) : null,
      topic1: r.topic1 ? bufToHex(r.topic1) : null,
      topic2: r.topic2 ? bufToHex(r.topic2) : null,
      topic3: r.topic3 ? bufToHex(r.topic3) : null,
      data: bufToHex(r.data),
    }));
    const last = page[page.length - 1];

    const blockNumbers = [...new Set(page.map((r) => r.blockNumber))];
    const blockRows =
      blockNumbers.length > 0
        ? await ctx.db
            .select({ number: blocks.number, timestamp: blocks.timestamp })
            .from(blocks)
            .where(inArray(blocks.number, blockNumbers))
        : [];
    const tsByBlock = new Map(blockRows.map((b) => [b.number, b.timestamp]));
    const viemAbi = abi as Abi | null;

    const items: ContractEventLog[] = page.map((r) => {
      const topics = [r.topic0, r.topic1, r.topic2, r.topic3].filter(
        (t): t is string => t != null,
      );
      return {
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
        txHash: r.txHash,
        timestamp: tsByBlock.get(r.blockNumber) ?? 0,
        topics,
        data: r.data,
        decoded: viemAbi ? decodeLogWithAbi(viemAbi, r.data, topics) : null,
      };
    });
    return {
      items,
      nextCursor: rows.length > limit && last ? `${last.blockNumber}_${last.logIndex}` : null,
    };
  }

  return {
    getCodeInfo,
    detectProxy,
    findCreator,
    detectToken,
    getVerifiedSource,
    getContractInfo,
    readFunction,
    getEvents,
  };
}

export type Contract = ReturnType<typeof makeContract>;
