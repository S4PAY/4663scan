import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt, asc } from 'drizzle-orm';
import { blocks, transactions, type TxRow } from '@4663scan/shared/db/schema';
import type {
  BlockDetail,
  BlockSummary,
  Paginated,
  TxSummary,
} from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { ApiHttpError, badRequest, notFound } from '../lib/errors.js';
import {
  parseLimit,
  parseNumberCursor,
  parsePairCursor,
  rowGt,
} from '../lib/params.js';
import { memo } from '../lib/ttl.js';
import { toBlockSummary } from '../views.js';

/** Block route id: decimal number or 0x block hash. */
function parseBlockId(raw: string): number | string {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw badRequest('invalid block id');
    return n;
  }
  const h = raw.toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(h)) return h;
  throw badRequest('invalid block id');
}

type ListQuery = { Querystring: Record<string, unknown> };
type IdQuery = { Params: { id: string }; Querystring: Record<string, unknown> };

export function registerBlockRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<ListQuery>('/blocks', async (req, reply) => {
    const limit = parseLimit(req.query.limit);
    const cursor = parseNumberCursor(req.query.cursor);

    const list = async (): Promise<Paginated<BlockSummary>> => {
      const rows = await ctx.db
        .select()
        .from(blocks)
        .where(cursor != null ? lt(blocks.number, cursor) : undefined)
        .orderBy(desc(blocks.number))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(toBlockSummary);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: rows.length > limit && last ? String(last.number) : null,
      };
    };

    const payload =
      cursor == null ? await memo(`blocks:${limit}`, 1000, list) : await list();
    setCache(reply, 'short');
    return payload;
  });

  app.get<IdQuery>('/blocks/:id', async (req, reply) => {
    const id = parseBlockId(req.params.id);
    const found = await s.cold.ensureBlock(id);
    if (!found) throw notFound();
    const row = found.row;
    // Hydration guarantees detail columns on served responses; a slim row
    // here means the hydrate raced a demotion — no partial detail, ever.
    if (row.parentHash == null || row.miner == null) {
      throw new ApiHttpError(502, 'upstream block unavailable');
    }
    const indexedHead = await s.heads.indexedHead();
    const confirmations = Math.max(indexedHead, row.number) - row.number + 1;
    const deep = confirmations >= ctx.env.CONFIRM_DEPTH;
    // Ephemeral near-head results may still reorg and stay short; hydrated
    // slim-tier bundles are deterministic from chain and cache immutably.
    setCache(reply, deep && (!found.ephemeral || found.hydrated) ? 'immutable' : 'short');
    const detail: BlockDetail = {
      ...toBlockSummary(row),
      parentHash: row.parentHash,
      size: row.size,
      l1BlockNumber: row.l1BlockNumber,
      confirmations,
    };
    return detail;
  });

  app.get<IdQuery>('/blocks/:id/txs', async (req, reply) => {
    const id = parseBlockId(req.params.id);
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);
    // Slim blocks serve summaries straight from their DB tx rows (those
    // survive demotion forever) — no RPC hydrate for a list page.
    const found = await s.cold.ensureBlock(id, { hydrateSlim: false });
    if (!found) throw notFound();
    const { row, ephemeral } = found;

    let rows: TxRow[];
    if (ephemeral) {
      // Near-head block served straight from the RPC: page its txs in-memory.
      const all = (ephemeral.txs as TxRow[])
        .slice()
        .sort((a, b) => a.txIndex - b.txIndex);
      const after = cursor
        ? all.filter(
            (t) =>
              t.blockNumber > cursor[0] ||
              (t.blockNumber === cursor[0] && t.txIndex > cursor[1]),
          )
        : all;
      rows = after.slice(0, limit + 1);
    } else {
      rows = await ctx.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.blockNumber, row.number),
            cursor
              ? rowGt(transactions.blockNumber, transactions.txIndex, cursor)
              : undefined,
          ),
        )
        .orderBy(asc(transactions.txIndex))
        .limit(limit + 1);
    }

    const page = rows.slice(0, limit);
    const items = await s.views.toTxSummaries(page);
    const last = page[page.length - 1];
    const payload: Paginated<TxSummary> = {
      items,
      nextCursor:
        rows.length > limit && last ? `${last.blockNumber}_${last.txIndex}` : null,
    };
    const indexedHead = await s.heads.indexedHead();
    const deep =
      Math.max(indexedHead, row.number) - row.number + 1 >= ctx.env.CONFIRM_DEPTH;
    // 'immutable' only when the content can never change: persisted, deep,
    // and every selector on the page resolved or known-negative in the DB —
    // otherwise a transient methodName:null would be cached for a year.
    let policy: 'immutable' | 'short' = 'short';
    if (deep && !ephemeral) {
      const unresolved = [
        ...new Set(
          items.flatMap((i) =>
            i.methodId != null && i.methodName == null ? [i.methodId] : [],
          ),
        ),
      ];
      if (await s.decode.selectorsKnownNegative(unresolved)) policy = 'immutable';
    }
    setCache(reply, policy);
    return payload;
  });
}
