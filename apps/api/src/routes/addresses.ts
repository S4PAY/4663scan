import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import { addressLabels, tokenTransfers, transactions } from '@4663scan/shared/db/schema';
import { hexToBuf } from '@4663scan/shared/db/hex-bytea';
import type {
  AddressSummary,
  Paginated,
  TokenHolding,
  TokenTransferView,
  TxSummary,
} from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { parseLimit, parsePairCursor, parseSort, requireAddress, rowGt, rowLt } from '../lib/params.js';
import { withTimeout } from '../lib/timeout.js';

const TX_COUNT_CAP = 10_001; // sentinel: the web renders it as "10k+"
/** Budget for live RPC lookups; on expiry the route degrades, never 500s. */
const LIVE_RPC_TIMEOUT_MS = 2_500;
const HOLDINGS_TIMEOUT_MS = 5_000;

/** Merge keyset streams: de-dupe, sort by `cmp`, page to `limit`. */
function mergePage<T>(
  lists: T[][],
  key: (t: T) => string,
  cmp: (x: T, y: T) => number,
  limit: number,
): { page: T[]; hasMore: boolean } {
  const seen = new Set<string>();
  const all: T[] = [];
  for (const t of lists.flat()) {
    const k = key(t);
    if (!seen.has(k)) {
      seen.add(k);
      all.push(t);
    }
  }
  all.sort(cmp);
  return { page: all.slice(0, limit), hasMore: all.length > limit };
}

type AddrParams = { Params: { address: string }; Querystring: Record<string, unknown> };

export function registerAddressRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<AddrParams>('/addresses/:address', async (req, reply) => {
    const address = requireAddress(req.params.address);

    const countTxs = async (): Promise<number> => {
      // from + to + contract-creations, minus the self-tx (from == to)
      // overlap so those are not double-counted; creations cannot overlap
      // (their `to` is null and `from` is the deployer). The self probe only
      // scans the capped from-side slice: its precision only matters when the
      // from side is under the cap (otherwise the sum caps to 10k+ anyway),
      // which keeps every term index-bounded for hub addresses.
      // Raw SQL bypasses the hexBytea codec: bind bytea params as Buffers.
      const addr = hexToBuf(address);
      const rows = await ctx.sql<{ c: number }[]>`
        select
          (select count(*) from (select 1 from transactions where "from" = ${addr} limit ${TX_COUNT_CAP}) f)::int
          + (select count(*) from (select 1 from transactions where "to" = ${addr} limit ${TX_COUNT_CAP}) t)::int
          + (select count(*) from (select 1 from transactions where contract_address = ${addr} limit ${TX_COUNT_CAP}) cr)::int
          - (select count(*) from (
              select 1 from (
                select "to" from transactions where "from" = ${addr}
                order by block_number desc, tx_index desc
                limit ${TX_COUNT_CAP}
              ) q where q."to" = ${addr}
            ) sf)::int
          as c`;
      return Math.min(Math.max(rows[0]?.c ?? 0, 0), TX_COUNT_CAP);
    };

    // Live RPC lookups are bounded and degrade to unknowns: an RPC outage
    // must not take down a page whose substance lives in Postgres.
    const [balanceWei, isContract, labelRows, tokenRefs, indexedTxCount] =
      await Promise.all([
        withTimeout(s.live.getBalance(address), LIVE_RPC_TIMEOUT_MS, 'balance').catch(
          () => null,
        ),
        withTimeout(s.live.isContract(address), LIVE_RPC_TIMEOUT_MS, 'code').catch(
          () => false,
        ),
        ctx.db
          .select({ label: addressLabels.label, category: addressLabels.category })
          .from(addressLabels)
          .where(eq(addressLabels.address, address)),
        s.meta.resolveTokenRefs([address]),
        countTxs(),
      ]);

    setCache(reply, 'short');
    const summary: AddressSummary = {
      address,
      balanceWei,
      isContract,
      labels: labelRows,
      token: tokenRefs.get(address) ?? null,
      indexedTxCount,
    };
    return summary;
  });

  app.get<AddrParams>('/addresses/:address/txs', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);
    // 'asc' exists solely so the web can cheaply ask for this address's
    // OLDEST indexed activity (limit=1&sort=asc) for "first activity" /
    // "funded by" — same query, same indexes, just walked from the other
    // end; no new data model or RPC pattern, just the existing rows in
    // reverse. Pagination continuity across a sort change isn't a goal —
    // callers doing that would need to restart from cursor=null anyway.
    const sort = parseSort(req.query.sort);
    const dir = sort === 'asc' ? asc : desc;
    const rowCmp = sort === 'asc' ? rowGt : rowLt;

    const side = (
      col:
        | typeof transactions.from
        | typeof transactions.to
        | typeof transactions.contractAddress,
    ) =>
      ctx.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(col, address),
            cursor ? rowCmp(transactions.blockNumber, transactions.txIndex, cursor) : undefined,
          ),
        )
        .orderBy(dir(transactions.blockNumber), dir(transactions.txIndex))
        .limit(limit + 1);

    // Third side: the tx that deployed this contract (to is null there, so
    // it can never surface via from/to).
    const [fromRows, toRows, createdRows] = await Promise.all([
      side(transactions.from),
      side(transactions.to),
      side(transactions.contractAddress),
    ]);
    // Base expression sorts descending; flip its sign for ascending —
    // verified against the original (pre-sort-param) comparator, which was
    // exactly this expression with an implicit sign of +1.
    const sign = sort === 'asc' ? -1 : 1;
    const { page, hasMore } = mergePage(
      [fromRows, toRows, createdRows],
      (t) => t.hash,
      (x, y) => sign * (y.blockNumber - x.blockNumber || y.txIndex - x.txIndex),
      limit,
    );
    const items = await s.views.toTxSummaries(page);
    const last = page[page.length - 1];
    setCache(reply, 'short');
    const payload: Paginated<TxSummary> = {
      items,
      nextCursor: hasMore && last ? `${last.blockNumber}_${last.txIndex}` : null,
    };
    return payload;
  });

  app.get<AddrParams>('/addresses/:address/transfers', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);

    const side = (col: typeof tokenTransfers.from | typeof tokenTransfers.to) =>
      ctx.db
        .select()
        .from(tokenTransfers)
        .where(
          and(
            eq(col, address),
            cursor
              ? rowLt(tokenTransfers.blockNumber, tokenTransfers.logIndex, cursor)
              : undefined,
          ),
        )
        .orderBy(desc(tokenTransfers.blockNumber), desc(tokenTransfers.logIndex))
        .limit(limit + 1);

    const [fromRows, toRows] = await Promise.all([
      side(tokenTransfers.from),
      side(tokenTransfers.to),
    ]);
    const { page, hasMore } = mergePage(
      [fromRows, toRows],
      (t) => `${t.blockNumber}_${t.logIndex}`,
      (x, y) => y.blockNumber - x.blockNumber || y.logIndex - x.logIndex,
      limit,
    );
    const items = await s.views.toTransferViews(page);
    const last = page[page.length - 1];
    setCache(reply, 'short');
    const payload: Paginated<TokenTransferView> = {
      items,
      nextCursor: hasMore && last ? `${last.blockNumber}_${last.logIndex}` : null,
    };
    return payload;
  });

  app.get<AddrParams>('/addresses/:address/tokens', async (req, reply) => {
    const address = requireAddress(req.params.address);
    // null (RPC failure) or a stall past the budget degrades honestly: the
    // web renders "temporarily unavailable", never a false "no holdings".
    const result: TokenHolding[] | null = await withTimeout(
      s.live.tokenHoldings(address),
      HOLDINGS_TIMEOUT_MS,
      'holdings',
    ).catch(() => null);
    setCache(reply, 'short');
    return { items: result ?? [], degraded: result == null };
  });
}
