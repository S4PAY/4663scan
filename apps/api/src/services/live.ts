import { eq, sql } from 'drizzle-orm';
import { erc20Abi, MULTICALL3_ADDRESS } from '@4663scan/shared/abi';
import type { TokenHolding } from '@4663scan/shared/api-types';
import { addressTokenSeen, tokens } from '@4663scan/shared/db/schema';
import type { AppContext } from '../context.js';
import { TtlMap, dedupe } from '../lib/ttl.js';
import { withTimeout } from '../lib/timeout.js';
import { asHex } from '../lib/params.js';
import type { Meta } from './labels.js';

const YEAR_MS = 365 * 86_400_000;
/**
 * Cap on the seen-pair set fed to the balanceOf multicall; bounds cost for
 * spam-blasted addresses. Deterministic (token address order), so the same
 * tokens are always the ones considered.
 */
const HOLDINGS_MAX_TOKENS = 200;
/**
 * Calldata bytes per multicall chunk. viem counts raw per-call calldata (36
 * bytes for balanceOf), so 2048 ≈ 56 calls per eth_call — small enough that
 * one gas-bomb token only sinks its own chunk, not the whole wallet.
 */
const MULTICALL_BATCH_BYTES = 2_048;
const HOLDINGS_TTL_MS = 30_000;
/** Failed holdings lookups are cached briefly so outages can't stampede. */
const HOLDINGS_FAILURE_TTL_MS = 5_000;
const MULTICALL_TIMEOUT_MS = 3_000;

export function makeLive(ctx: AppContext, meta: Meta) {
  const balanceCache = new TtlMap<string, string>(3000, 5000);
  // Contract-ness at an address is effectively stable: positives ~forever,
  // negatives 60s (an EOA can become a contract via deployment).
  const contractCache = new TtlMap<string, boolean>(60_000, 20_000);
  // null = the last lookup failed (degraded), cached briefly like a result.
  const holdingsCache = new TtlMap<string, TokenHolding[] | null>(
    HOLDINGS_TTL_MS,
    2000,
  );

  async function getBalance(address: string): Promise<string> {
    const hit = balanceCache.get(address);
    if (hit !== undefined) return hit;
    const wei = await dedupe(`live:bal:${address}`, () =>
      ctx.client.getBalance({ address: asHex(address) }),
    );
    const s = wei.toString();
    balanceCache.set(address, s);
    return s;
  }

  async function isContract(address: string): Promise<boolean> {
    const hit = contractCache.get(address);
    if (hit !== undefined) return hit;
    const code = await dedupe(`live:code:${address}`, () =>
      ctx.client.getCode({ address: asHex(address) }),
    );
    const yes = code != null && code !== '0x';
    contractCache.set(address, yes, yes ? YEAR_MS : 60_000);
    return yes;
  }

  /** null = live lookup failed; callers surface that as degraded, not empty. */
  async function tokenHoldings(address: string): Promise<TokenHolding[] | null> {
    const hit = holdingsCache.get(address);
    if (hit !== undefined) return hit;
    return dedupe(`live:hold:${address}`, async () => {
      // Candidate tokens come from the forever-tier address_token_seen pairs
      // — never from token_transfers, which retention prunes past the hot
      // window (a wallet's older tokens would silently vanish). Stock tokens
      // sort first so spam pairs can never displace them from the cap; the
      // non-stock remainder is deterministic (token address order) but can be
      // displaced past the cap by spam dusting (docs/architecture.md).
      const seenRows = await ctx.db
        .select({ tokenAddress: addressTokenSeen.tokenAddress })
        .from(addressTokenSeen)
        .leftJoin(tokens, eq(tokens.address, addressTokenSeen.tokenAddress))
        .where(eq(addressTokenSeen.address, address))
        .orderBy(
          sql`coalesce(${tokens.isStockToken}, false) desc`,
          addressTokenSeen.tokenAddress,
        )
        .limit(HOLDINGS_MAX_TOKENS);
      const seen = seenRows.map((r) => r.tokenAddress);
      if (seen.length === 0) {
        holdingsCache.set(address, []);
        return [];
      }

      let results;
      try {
        results = await withTimeout(
          ctx.client.multicall({
            allowFailure: true,
            batchSize: MULTICALL_BATCH_BYTES,
            multicallAddress: asHex(MULTICALL3_ADDRESS),
            contracts: seen.map((tokenAddress) => ({
              address: asHex(tokenAddress),
              abi: erc20Abi,
              functionName: 'balanceOf' as const,
              args: [asHex(address)] as const,
            })),
          }),
          MULTICALL_TIMEOUT_MS,
          'holdings multicall',
        );
      } catch {
        // RPC outage: signal degraded briefly instead of faking "no holdings".
        holdingsCache.set(address, null, HOLDINGS_FAILURE_TTL_MS);
        return null;
      }

      // allowFailure:true RESOLVES on network/chunk errors with per-call
      // status 'failure' — an RPC outage never reaches the catch above. Every
      // call failing is an outage signature, not a wallet of 200 broken
      // tokens: degrade instead of caching a false "no holdings".
      if (!results.some((r) => r?.status === 'success')) {
        holdingsCache.set(address, null, HOLDINGS_FAILURE_TTL_MS);
        return null;
      }

      const refs = await meta.resolveTokenRefs(seen);
      const holdings: TokenHolding[] = [];
      for (let i = 0; i < seen.length; i++) {
        const res = results[i];
        if (!res || res.status !== 'success') continue;
        if (typeof res.result !== 'bigint' || res.result === 0n) continue;
        const tokenAddress = seen[i]!;
        holdings.push({
          token: refs.get(tokenAddress) ?? {
            address: tokenAddress,
            name: null,
            symbol: null,
            decimals: null,
            isStockToken: false,
          },
          balance: res.result.toString(),
        });
      }
      // Stock tokens first, then symbol, then address — stable across loads
      // (the old transfer-recency order died with the probe).
      holdings.sort(
        (a, b) =>
          Number(b.token.isStockToken) - Number(a.token.isStockToken) ||
          (a.token.symbol ?? '\uffff').localeCompare(b.token.symbol ?? '\uffff') ||
          a.token.address.localeCompare(b.token.address),
      );
      holdingsCache.set(address, holdings);
      return holdings;
    });
  }

  return { getBalance, isContract, tokenHoldings };
}

export type Live = ReturnType<typeof makeLive>;
