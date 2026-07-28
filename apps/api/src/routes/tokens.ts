import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import {
  stockTokens,
  tokenSubmissions,
  tokenTransfers,
  tokens,
} from '@4663scan/shared/db/schema';
import { bufToHex, hexToBuf } from '@4663scan/shared/db/hex-bytea';
import type {
  Paginated,
  TokenInfo,
  TokenTransferView,
} from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  escapeLike,
  parseLimit,
  parseOffsetCursor,
  parsePairCursor,
  requireAddress,
  requireNulFree,
  rowLt,
} from '../lib/params.js';
import { memo } from '../lib/ttl.js';
import { toTokenInfo } from '../views.js';

const TRANSFER_COUNT_CAP = 100_001; // sentinel: the web renders it as "100k+"

type ListQuery = { Querystring: Record<string, unknown> };
type AddrParams = { Params: { address: string }; Querystring: Record<string, unknown> };

export function registerTokenRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<ListQuery>('/tokens', async (req, reply) => {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffsetCursor(req.query.cursor);
    const stockRaw = req.query.stock;
    if (stockRaw !== undefined && stockRaw !== 'true' && stockRaw !== 'false') {
      throw badRequest('invalid stock filter');
    }
    const qRaw = req.query.q;
    if (qRaw !== undefined && typeof qRaw !== 'string') throw badRequest('invalid q');
    const q = qRaw !== undefined ? requireNulFree(qRaw).trim() : '';

    const filters: SQL[] = [];
    if (stockRaw !== undefined) {
      filters.push(eq(tokens.isStockToken, stockRaw === 'true'));
    }
    if (q !== '') {
      const esc = escapeLike(q);
      filters.push(
        or(ilike(tokens.symbol, `${esc}%`), ilike(tokens.name, `%${esc}%`))!,
      );
    }

    // Capped per-token transfer counts for one page of tokens; each probe is
    // a LIMIT-bounded index-only scan on transfers_token_idx. Raw SQL
    // bypasses the hexBytea codec: bytea params in as Buffers, out again as
    // Buffers that must be re-hexed for the string-keyed map.
    const transferCounts = async (
      addresses: string[],
    ): Promise<Map<string, number>> => {
      if (addresses.length === 0) return new Map();
      const rows = await ctx.sql<{ address: Buffer; c: number }[]>`
        select a.address, (
          select count(*)::int from (
            select 1 from token_transfers x
            where x.token_address = a.address
            limit ${TRANSFER_COUNT_CAP}
          ) s
        ) as c
        from unnest(${ctx.sql.array(addresses.map(hexToBuf))}::bytea[]) as a(address)`;
      return new Map(
        rows.map((r) => [bufToHex(r.address), Math.min(r.c, TRANSFER_COUNT_CAP)]),
      );
    };

    const list = async (): Promise<Paginated<TokenInfo>> => {
      const rows = await ctx.db
        .select({ token: tokens, stock: stockTokens })
        .from(tokens)
        .leftJoin(stockTokens, eq(stockTokens.tokenAddress, tokens.address))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(
          desc(tokens.isStockToken),
          sql`${tokens.symbol} asc nulls last`,
          asc(tokens.address),
        )
        .offset(offset)
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const counts = await transferCounts(page.map((r) => r.token.address));
      const items = page.map((r) =>
        toTokenInfo(r.token, r.stock, counts.get(r.token.address) ?? null),
      );
      return {
        items,
        nextCursor: rows.length > limit ? String(offset + limit) : null,
      };
    };

    const payload =
      q === '' && offset === 0
        ? await memo(`tokens:${limit}:${stockRaw ?? ''}`, 1000, list)
        : await list();
    setCache(reply, 'short');
    return payload;
  });

  app.get<AddrParams>('/tokens/:address', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const rows = await ctx.db
      .select({ token: tokens, stock: stockTokens })
      .from(tokens)
      .leftJoin(stockTokens, eq(stockTokens.tokenAddress, tokens.address))
      .where(eq(tokens.address, address))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound();

    // Raw SQL bypasses the hexBytea codec: bind the bytea param as a Buffer.
    const [countRows, holderRows, communityRows] = await Promise.all([
      ctx.sql<{ c: number }[]>`
        select count(*)::int as c from (
          select 1 from token_transfers where token_address = ${hexToBuf(address)}
          limit ${TRANSFER_COUNT_CAP}
        ) t`,
      // address_token_seen_token_idx makes this a plain indexed count — no
      // full-table scan (see the M5 logs-query lesson this index avoids
      // repeating). PK is (address, token_address), so every matching row
      // is already a distinct holder; no DISTINCT needed. "Ever held", not
      // a live current-holder count (docs on TokenInfo.holderCount).
      ctx.sql<{ c: number }[]>`
        select count(*)::int as c from (
          select 1 from address_token_seen where token_address = ${hexToBuf(address)}
          limit ${TRANSFER_COUNT_CAP}
        ) h`,
      // Most recent *approved* community submission, if any (docs/ops.md
      // "Token submissions") — the same reviewed/approved row any
      // third-party listing would go through, not a per-token special case.
      ctx.db
        .select()
        .from(tokenSubmissions)
        .where(
          and(eq(tokenSubmissions.tokenAddress, address), eq(tokenSubmissions.status, 'approved')),
        )
        .orderBy(desc(tokenSubmissions.reviewedAt))
        .limit(1),
    ]);
    const transferCount = Math.min(countRows[0]?.c ?? 0, TRANSFER_COUNT_CAP);
    const holderCount = Math.min(holderRows[0]?.c ?? 0, TRANSFER_COUNT_CAP);

    setCache(reply, 'short');
    return toTokenInfo(row.token, row.stock, transferCount, holderCount, communityRows[0] ?? null);
  });

  app.get<AddrParams>('/tokens/:address/transfers', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);

    const rows = await ctx.db
      .select()
      .from(tokenTransfers)
      .where(
        and(
          eq(tokenTransfers.tokenAddress, address),
          cursor
            ? rowLt(tokenTransfers.blockNumber, tokenTransfers.logIndex, cursor)
            : undefined,
        ),
      )
      .orderBy(desc(tokenTransfers.blockNumber), desc(tokenTransfers.logIndex))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const items = await s.views.toTransferViews(page);
    const last = page[page.length - 1];
    setCache(reply, 'short');
    const payload: Paginated<TokenTransferView> = {
      items,
      nextCursor:
        rows.length > limit && last
          ? `${last.blockNumber}_${last.logIndex}`
          : null,
    };
    return payload;
  });
}
