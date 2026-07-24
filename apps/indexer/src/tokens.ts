import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  AbiDecodingDataSizeInvalidError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  RawContractError,
  ResourceUnavailableRpcError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
  type MulticallParameters,
  type PublicClient,
} from 'viem';
import { MULTICALL3_ADDRESS, erc20Abi, erc20Bytes32Abi } from '@4663scan/shared/abi';
import { stockTokens, tokens, type Db, type TokenInsert } from '@4663scan/shared/db';
import stockRegistry from '@4663scan/shared/stock-registry.json';
import { classifyAssetClass, ensureLogoFetched, fetchRhjLogoMap } from './logos.js';
import type { RateLimiter } from './rate-limiter.js';
import type { RpcClient } from './rpc.js';
import { chunk, sleep } from './util.js';

const METADATA_INTERVAL_MS = 15_000;
const FULL_SCAN_INTERVAL_MS = 600_000;
const METADATA_BATCH = 50;
const MULTICALL_GROUP = 20;
const NAME_MAX = 128;
const SYMBOL_MAX = 32;
/** Transient metadata failures retry with exponential backoff (30s … 1h);
 *  only after MAX attempts (~2h spread) is a token marked done permanently. */
const META_MAX_ATTEMPTS = 8;
const META_BACKOFF_BASE_MS = 30_000;
const META_BACKOFF_MAX_MS = 3_600_000;

/** StockFactory proxy — the on-chain authority for stock-token verification. */
const STOCK_FACTORY =
  stockRegistry.issuerAddresses.find((i) => i.label.includes('StockFactory (proxy)'))
    ?.address ?? '0x4783c67b63de2b358ac5951a7d41f47a38f3c046';

/** Stock.uid() — genuine Robinhood Stock (ERC-8056) tokens expose their
 *  Robinhood asset UUID as a bytes32. The value is attacker-controlled and is
 *  only ever used as a lookup key into the factory below. */
const stockUidAbi = [
  {
    type: 'function',
    name: 'uid',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

/** StockFactory.tokenAddress(bytes32 uid) — the authoritative uid → token
 *  mapping, written only by the factory's restricted deploy(). */
const stockFactoryAbi = [
  {
    type: 'function',
    name: 'tokenAddress',
    stateMutability: 'view',
    inputs: [{ name: 'uid_', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

interface TokenMeta {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  /** True when every call reached the chain (success or contract-level
   *  failure); false when any failed at the transport/node level. */
  definitive: boolean;
}

interface DiscoveryCandidate {
  address: string;
  name: string | null;
  symbol: string | null;
  isStockToken: boolean;
}

type McResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown; result?: unknown };

function cleanText(raw: string | null, maxLen: number): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maxLen);
}

function decodeBytes32(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('0x')) return null;
  const buf = Buffer.from(v.slice(2), 'hex');
  const nul = buf.indexOf(0);
  return buf.toString('utf8', 0, nul === -1 ? buf.length : nul);
}

/** Retry bookkeeping kept in tokens.metadata (jsonb). */
interface MetaFetchState {
  metaAttempts?: number;
  metaNextRetryMs?: number;
  metaGaveUpMs?: number;
}

function metaState(raw: unknown): MetaFetchState & Record<string, unknown> {
  return typeof raw === 'object' && raw != null && !Array.isArray(raw)
    ? (raw as MetaFetchState & Record<string, unknown>)
    : {};
}

const metaBackoffMs = (attempts: number): number =>
  Math.min(META_BACKOFF_BASE_MS * 2 ** (attempts - 1), META_BACKOFF_MAX_MS);

/** Errors that mean the request never (reliably) reached the chain. */
const TRANSIENT_RPC_ERRORS = [
  HttpRequestError,
  TimeoutError,
  SocketClosedError,
  WebSocketRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
] as const;

/** Errors that are a definitive on-chain outcome for the target contract. */
const DEFINITIVE_CALL_ERRORS = [
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  RawContractError,
  AbiDecodingZeroDataError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingDataSizeInvalidError,
] as const;

/**
 * True when a call failure is a definitive on-chain outcome (revert, empty
 * returndata from a non-contract, undecodable returndata) rather than a
 * transport / node failure that deserves a retry. Transient markers win:
 * viem wraps some node-level errors (e.g. InternalRpcError) in
 * ContractFunctionRevertedError, so revert evidence alone is not trusted
 * when a transient marker appears anywhere in the cause chain. Unknown
 * errors default to transient — the attempt cap bounds the retries.
 */
function isDefinitiveCallError(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (err.walk((e) => TRANSIENT_RPC_ERRORS.some((c) => e instanceof c)) != null) {
    return false;
  }
  return err.walk((e) => DEFINITIVE_CALL_ERRORS.some((c) => e instanceof c)) != null;
}

/**
 * Token metadata worker + Robinhood stock-token discovery. Genuine stock
 * tokens are BeaconProxies deployed by the StockFactory; counterfeit
 * name-alikes exist on this chain (and anything the token itself returns is
 * attacker-controlled), so pattern matches are verified against the FACTORY:
 * the candidate's uid() is used only as a lookup key, and the factory must
 * map that uid back to the candidate's own address.
 */
export class TokenWorker {
  private running = false;
  private busyMeta = false;
  private busyScan = false;
  private metaTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  /** Definitively failed verifications are fakes; never re-checked within
   *  this process. Transient RPC failures are NOT recorded here. */
  private readonly rejected = new Set<string>();
  private readonly registryAddresses = new Set(
    stockRegistry.tokens.map((t) => t.address.toLowerCase()),
  );
  private readonly namePatterns = stockRegistry.namePatterns.map((p) => new RegExp(p, 'u'));

  constructor(
    private readonly db: Db,
    private readonly client: PublicClient,
    private readonly rpc: RpcClient,
    private readonly limiter: RateLimiter,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.running = true;
    void this.runMetadataOnce();
    void this.runFullScan();
    this.metaTimer = setInterval(() => void this.runMetadataOnce(), METADATA_INTERVAL_MS);
    this.scanTimer = setInterval(() => void this.runFullScan(), FULL_SCAN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.metaTimer) clearInterval(this.metaTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    while (this.busyMeta || this.busyScan) await sleep(50);
  }

  private async runMetadataOnce(): Promise<void> {
    if (this.busyMeta || !this.running) return;
    this.busyMeta = true;
    try {
      const now = Date.now();
      const pending = await this.db
        .select({
          address: tokens.address,
          isStockToken: tokens.isStockToken,
          metadata: tokens.metadata,
        })
        .from(tokens)
        .where(
          and(
            eq(tokens.metadataFetched, false),
            // Backoff gate for rows with a prior transient failure.
            sql`coalesce((${tokens.metadata} ->> 'metaNextRetryMs')::numeric, 0) <= ${now}`,
          ),
        )
        .limit(METADATA_BATCH);
      if (pending.length === 0) return;

      const prevByAddress = new Map(pending.map((p) => [p.address, p.metadata]));
      const metas = await this.fetchMetadata(pending.map((p) => p.address));
      // Cross-worker convention: token rows are written address-ascending.
      metas.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

      let retried = 0;
      let gaveUp = 0;
      for (const m of metas) {
        const prev = metaState(prevByAddress.get(m.address));
        if (m.definitive) {
          // The chain answered for every field; nulls are genuine absences.
          const rest: Record<string, unknown> = { ...prev };
          delete rest.metaAttempts;
          delete rest.metaNextRetryMs;
          delete rest.metaGaveUpMs;
          await this.db
            .update(tokens)
            .set({
              name: m.name,
              symbol: m.symbol,
              decimals: m.decimals,
              totalSupply: m.totalSupply,
              metadataFetched: true,
              metadata: Object.keys(rest).length > 0 ? rest : null,
            })
            .where(eq(tokens.address, m.address));
          continue;
        }
        // Transport-level failure: keep whatever fields did come back (never
        // clobbering stored values with nulls), count the attempt, and either
        // back off for a retry or give up permanently after the cap.
        const attempts =
          (typeof prev.metaAttempts === 'number' ? prev.metaAttempts : 0) + 1;
        const patch: Partial<TokenInsert> = {};
        if (m.name != null) patch.name = m.name;
        if (m.symbol != null) patch.symbol = m.symbol;
        if (m.decimals != null) patch.decimals = m.decimals;
        if (m.totalSupply != null) patch.totalSupply = m.totalSupply;
        if (attempts >= META_MAX_ATTEMPTS) {
          patch.metadataFetched = true;
          patch.metadata = { ...prev, metaAttempts: attempts, metaGaveUpMs: now };
          gaveUp++;
        } else {
          patch.metadata = {
            ...prev,
            metaAttempts: attempts,
            metaNextRetryMs: now + metaBackoffMs(attempts),
          };
          retried++;
        }
        await this.db.update(tokens).set(patch).where(eq(tokens.address, m.address));
      }
      this.logger.info(
        {
          fetched: metas.length,
          named: metas.filter((m) => m.name != null).length,
          retried,
          gaveUp,
        },
        'token metadata batch',
      );

      const stockFlag = new Map(pending.map((p) => [p.address, p.isStockToken]));
      await this.discover(
        metas.map((m) => ({
          address: m.address,
          name: m.name,
          symbol: m.symbol,
          isStockToken: stockFlag.get(m.address) ?? false,
        })),
      );
    } catch (err) {
      this.logger.warn({ err }, 'token metadata batch failed');
    } finally {
      this.busyMeta = false;
    }
  }

  private async runFullScan(): Promise<void> {
    if (this.busyScan || !this.running) return;
    this.busyScan = true;
    try {
      const rows = await this.db
        .select({
          address: tokens.address,
          name: tokens.name,
          symbol: tokens.symbol,
          isStockToken: tokens.isStockToken,
        })
        .from(tokens)
        .where(isNotNull(tokens.name))
        .orderBy(tokens.address);
      await this.discover(rows);
    } catch (err) {
      this.logger.warn({ err }, 'stock discovery full scan failed');
    } finally {
      this.busyScan = false;
    }
  }

  private async fetchMetadata(addresses: string[]): Promise<TokenMeta[]> {
    const out: TokenMeta[] = [];
    for (const group of chunk(addresses, MULTICALL_GROUP)) {
      if (!this.running) break;
      try {
        out.push(...(await this.multicallGroup(group)));
      } catch (err) {
        this.logger.warn({ err }, 'multicall failed; falling back to per-token calls');
        for (const address of group) {
          if (!this.running) break;
          out.push(await this.fetchIndividual(address));
        }
      }
    }
    return out;
  }

  private async multicallGroup(group: string[]): Promise<TokenMeta[]> {
    await this.limiter.acquire(1, 'backfill');
    const contracts: MulticallParameters['contracts'] = group.flatMap((address) => {
      const addr = address as `0x${string}`;
      return [
        { address: addr, abi: erc20Abi, functionName: 'name' },
        { address: addr, abi: erc20Abi, functionName: 'symbol' },
        { address: addr, abi: erc20Abi, functionName: 'decimals' },
        { address: addr, abi: erc20Abi, functionName: 'totalSupply' },
      ];
    });
    const res = (await this.client.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    })) as McResult[];

    const val = (i: number): unknown => {
      const r = res[i];
      return r != null && r.status === 'success' ? r.result : null;
    };
    // viem surfaces chunk-level transport errors as per-call failures too
    // (allowFailure), so a failure only counts as an answer from the chain
    // when the wrapped error is a contract-level outcome.
    const answered = (i: number): boolean => {
      const r = res[i];
      return r != null && (r.status === 'success' || isDefinitiveCallError(r.error));
    };
    const metas = group.map((address, i) => {
      const m = this.assemble(address, val(i * 4), val(i * 4 + 1), val(i * 4 + 2), val(i * 4 + 3));
      m.definitive = [0, 1, 2, 3].every((k) => answered(i * 4 + k));
      return m;
    });

    // bytes32 name/symbol tokens (MKR-style) revert on string decode; retry.
    const needB32 = metas.filter(
      (m, i) =>
        (m.name == null && res[i * 4]?.status === 'failure') ||
        (m.symbol == null && res[i * 4 + 1]?.status === 'failure'),
    );
    if (needB32.length > 0) await this.bytes32Fallback(needB32);
    return metas;
  }

  private async bytes32Fallback(metas: TokenMeta[]): Promise<void> {
    try {
      await this.limiter.acquire(1, 'backfill');
      const contracts: MulticallParameters['contracts'] = metas.flatMap((m) => {
        const addr = m.address as `0x${string}`;
        return [
          { address: addr, abi: erc20Bytes32Abi, functionName: 'name' },
          { address: addr, abi: erc20Bytes32Abi, functionName: 'symbol' },
        ];
      });
      const res = (await this.client.multicall({
        contracts,
        allowFailure: true,
        multicallAddress: MULTICALL3_ADDRESS,
      })) as McResult[];
      metas.forEach((m, j) => {
        const name = res[j * 2];
        const symbol = res[j * 2 + 1];
        if (m.name == null && name?.status === 'success') {
          m.name = cleanText(decodeBytes32(name.result), NAME_MAX);
        }
        if (m.symbol == null && symbol?.status === 'success') {
          m.symbol = cleanText(decodeBytes32(symbol.result), SYMBOL_MAX);
        }
        // A transport failure here leaves the bytes32 variant unknown.
        if (
          (name?.status === 'failure' && !isDefinitiveCallError(name.error)) ||
          (symbol?.status === 'failure' && !isDefinitiveCallError(symbol.error))
        ) {
          m.definitive = false;
        }
      });
    } catch (err) {
      // Whole-call failure: cannot tell string-revert from bytes32; retry.
      for (const m of metas) m.definitive = false;
      this.logger.debug({ err }, 'bytes32 fallback multicall failed');
    }
  }

  private async fetchIndividual(address: string): Promise<TokenMeta> {
    await this.limiter.acquire(4, 'backfill');
    const addr = address as `0x${string}`;
    const settled = await Promise.allSettled([
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    const v = (r: PromiseSettledResult<unknown> | undefined): unknown =>
      r != null && r.status === 'fulfilled' ? r.value : null;
    const m = this.assemble(address, v(settled[0]), v(settled[1]), v(settled[2]), v(settled[3]));
    m.definitive = settled.every(
      (r) => r.status === 'fulfilled' || isDefinitiveCallError(r.reason),
    );
    return m;
  }

  private assemble(
    address: string,
    name: unknown,
    symbol: unknown,
    decimals: unknown,
    totalSupply: unknown,
  ): TokenMeta {
    const dec =
      typeof decimals === 'number'
        ? decimals
        : typeof decimals === 'bigint'
          ? Number(decimals)
          : null;
    return {
      address,
      name: cleanText(typeof name === 'string' ? name : null, NAME_MAX),
      symbol: cleanText(typeof symbol === 'string' ? symbol : null, SYMBOL_MAX),
      decimals: dec != null && Number.isInteger(dec) && dec >= 0 && dec <= 255 ? dec : null,
      totalSupply:
        typeof totalSupply === 'bigint'
          ? totalSupply.toString()
          : typeof totalSupply === 'number' && Number.isSafeInteger(totalSupply)
            ? String(totalSupply)
            : null,
      definitive: true,
    };
  }

  /**
   * Ask the FACTORY — not the token — whether this address is a genuine
   * stock token. The candidate's uid() is an untrusted hint used purely as a
   * lookup key; only StockFactory.deploy() writes the uid → address mapping,
   * so whatever uid a counterfeit claims resolves to the genuine token (or
   * zero), never to the counterfeit itself.
   */
  private async verifyViaFactory(
    address: string,
  ): Promise<'verified' | 'rejected' | 'transient'> {
    await this.limiter.acquire(2, 'backfill');
    let uid: `0x${string}`;
    try {
      uid = await this.client.readContract({
        address: address as `0x${string}`,
        abi: stockUidAbi,
        functionName: 'uid',
      });
    } catch (err) {
      // Genuine Stock tokens implement uid(); a definitive revert (or empty
      // returndata) rejects, a transport failure retries on a later pass.
      return isDefinitiveCallError(err) ? 'rejected' : 'transient';
    }
    try {
      const mapped = await this.client.readContract({
        address: STOCK_FACTORY as `0x${string}`,
        abi: stockFactoryAbi,
        functionName: 'tokenAddress',
        args: [uid],
      });
      return mapped.toLowerCase() === address ? 'verified' : 'rejected';
    } catch (err) {
      return isDefinitiveCallError(err) ? 'rejected' : 'transient';
    }
  }

  /**
   * Logo/asset-class enrichment for one newly-confirmed stock token —
   * plain HTTP to Robinhood's own asset list, never RPC, never touches
   * `this.limiter`. Fire-and-forget (never awaited by callers): a slow or
   * failing upstream fetch must not delay stock-token discovery, which is
   * the RPC-bound, indexer-critical part of this class. Failures are
   * logged and simply leave the logo unset — the fallback monogram tile
   * covers that in the UI, no retry loop needed here (the one-shot backfill
   * script or a later restart's own registry-flag pass will catch it).
   */
  private enrichNewStockToken(
    address: string,
    companyName: string | null,
    ticker?: string,
  ): void {
    void (async () => {
      try {
        if (companyName != null) {
          const assetClass = classifyAssetClass(companyName);
          if (assetClass) {
            await this.db
              .update(stockTokens)
              .set({ assetClass })
              .where(eq(stockTokens.tokenAddress, address));
          }
        }
        let effectiveTicker = ticker;
        if (!effectiveTicker) {
          const rows = await this.db
            .select({ ticker: stockTokens.ticker })
            .from(stockTokens)
            .where(eq(stockTokens.tokenAddress, address))
            .limit(1);
          effectiveTicker = rows[0]?.ticker;
        }
        if (!effectiveTicker) return;
        const logoMap = await fetchRhjLogoMap();
        await ensureLogoFetched(
          this.db,
          this.logger,
          address,
          effectiveTicker,
          logoMap.get(address),
        );
      } catch (err) {
        this.logger.warn({ token: address, err }, 'stock token enrichment failed');
      }
    })();
  }

  private async discover(cands: DiscoveryCandidate[]): Promise<void> {
    for (const c of cands) {
      if (!this.running) return;
      const address = c.address.toLowerCase();

      if (this.registryAddresses.has(address)) {
        // Trusted: registry rows are already seeded; just ensure the flag.
        if (!c.isStockToken) {
          await this.db
            .update(tokens)
            .set({ isStockToken: true })
            .where(eq(tokens.address, address));
          this.logger.info({ token: address }, 'registry stock token flagged');
        }
        // Idempotent (ensureLogoFetched no-ops once a logo exists) — a
        // cheap safety net in case the one-shot backfill hasn't run yet.
        this.enrichNewStockToken(address, null, c.symbol ?? undefined);
        continue;
      }
      if (c.isStockToken || this.rejected.has(address)) continue;
      const name = c.name;
      if (name == null || !this.namePatterns.some((re) => re.test(name))) continue;

      // Candidate only: verify against the StockFactory before trusting the
      // name — counterfeit lookalikes exist, and anything the token itself
      // returns (registry address, beacon slot) is forgeable.
      const verdict = await this.verifyViaFactory(address);
      if (verdict === 'transient') {
        this.logger.warn(
          { token: address, name },
          'stock verification hit transient RPC failure; will retry',
        );
        continue;
      }
      if (verdict === 'rejected') {
        this.rejected.add(address);
        this.logger.info(
          { token: address, name },
          'stock-name lookalike failed factory verification; ignoring',
        );
        continue;
      }

      await this.db
        .update(tokens)
        .set({ isStockToken: true })
        .where(eq(tokens.address, address));
      const companyName = name.replace(/\s*•\s*Robinhood Token\s*$/u, '').trim() || null;
      if (c.symbol != null) {
        // Never overwrite 'registry' rows.
        await this.db
          .insert(stockTokens)
          .values({
            tokenAddress: address,
            ticker: c.symbol,
            companyName,
            issuerAddress: STOCK_FACTORY,
            source: 'heuristic',
          })
          .onConflictDoNothing();
        this.enrichNewStockToken(address, companyName, c.symbol);
      }
      this.logger.info(
        { token: address, ticker: c.symbol, companyName },
        'stock token verified via factory',
      );
    }
  }
}
