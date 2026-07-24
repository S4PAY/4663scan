import type { FastifyInstance } from 'fastify';
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { addressLabels, blocks, tokens, transactions } from '@4663scan/shared/db/schema';
import type { SearchResponse, SearchResult } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { badRequest } from '../lib/errors.js';
import { escapeLike, requireNulFree } from '../lib/params.js';

type SearchQuery = { Querystring: Record<string, unknown> };

export function registerSearchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<SearchQuery>('/search', async (req, reply) => {
    const raw = req.query.q ?? '';
    if (typeof raw !== 'string') throw badRequest('invalid q');
    const query = requireNulFree(raw).trim();
    setCache(reply, 'short');
    const respond = (results: SearchResult[]): SearchResponse => ({ query, results });
    if (query === '') return respond([]);
    const lower = query.toLowerCase();

    // 32-byte hash: tx in DB → block by hash in DB → tx via RPC → block via
    // RPC (only ~a slice of history is indexed; both fallbacks are needed).
    if (/^0x[0-9a-f]{64}$/.test(lower)) {
      const txRows = await ctx.db
        .select({ hash: transactions.hash })
        .from(transactions)
        .where(eq(transactions.hash, lower))
        .limit(1);
      if (txRows[0]) return respond([{ type: 'tx', hash: lower }]);
      const blockRows = await ctx.db
        .select({ number: blocks.number, hash: blocks.hash })
        .from(blocks)
        .where(eq(blocks.hash, lower))
        .limit(1);
      const block = blockRows[0];
      if (block) {
        return respond([{ type: 'block', number: block.number, hash: block.hash }]);
      }
      if (await s.cold.probeTx(lower)) return respond([{ type: 'tx', hash: lower }]);
      const rpcBlock = await s.cold.probeBlockByHash(lower);
      if (rpcBlock) {
        return respond([{ type: 'block', number: rpcBlock.number, hash: rpcBlock.hash }]);
      }
      return respond([]);
    }

    // 20-byte address: always an address result; tokens get prepended.
    if (/^0x[0-9a-f]{40}$/.test(lower)) {
      const [labelMap, refMap] = await Promise.all([
        s.meta.resolveLabels([lower]),
        s.meta.resolveTokenRefs([lower]),
      ]);
      const results: SearchResult[] = [];
      const token = refMap.get(lower);
      if (token) {
        results.push({
          type: 'token',
          address: lower,
          name: token.name,
          symbol: token.symbol,
          isStockToken: token.isStockToken,
        });
      }
      results.push({
        type: 'address',
        address: lower,
        label: labelMap.get(lower) ?? null,
      });
      return respond(results);
    }

    // Decimal within chain height → block. Never cold-ingests from search;
    // un-indexed heights get a header-only hash probe so the result carries
    // a real hash (no '' placeholder). Probe failure → no result, degrade.
    if (/^\d{1,12}$/.test(query)) {
      const n = Number(query);
      const head = await s.heads.rpcHead().catch(() => -1);
      if (head >= 0 && n <= head) {
        const rows = await ctx.db
          .select({ hash: blocks.hash })
          .from(blocks)
          .where(eq(blocks.number, n))
          .limit(1);
        const hash = rows[0]?.hash ?? (await s.cold.probeBlockHashByNumber(n));
        if (hash) return respond([{ type: 'block', number: n, hash }]);
        return respond([]);
      }
    }

    // Free text: token symbol prefix / name contains, then label matches.
    const esc = escapeLike(query);
    const [tokenRows, labelRows] = await Promise.all([
      ctx.db
        .select({
          address: tokens.address,
          name: tokens.name,
          symbol: tokens.symbol,
          isStockToken: tokens.isStockToken,
        })
        .from(tokens)
        .where(or(ilike(tokens.symbol, `${esc}%`), ilike(tokens.name, `%${esc}%`)))
        .orderBy(desc(tokens.isStockToken), sql`${tokens.symbol} asc nulls last`)
        .limit(10),
      ctx.db
        .select({ address: addressLabels.address, label: addressLabels.label })
        .from(addressLabels)
        .where(ilike(addressLabels.label, `%${esc}%`))
        .limit(5),
    ]);
    const results: SearchResult[] = [
      ...tokenRows.map(
        (t): SearchResult => ({
          type: 'token',
          address: t.address,
          name: t.name,
          symbol: t.symbol,
          isStockToken: t.isStockToken,
        }),
      ),
      ...labelRows.map(
        (l): SearchResult => ({
          type: 'address',
          address: l.address,
          label: l.label,
        }),
      ),
    ];
    return respond(results);
  });
}
