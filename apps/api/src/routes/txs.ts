import type { FastifyInstance } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import {
  logs,
  tokenTransfers,
  transactions,
  type LogRow,
  type TokenTransferRow,
} from '@4663scan/shared/db/schema';
import type { Paginated, TxDetail, TxSummary } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { ApiHttpError, notFound } from '../lib/errors.js';
import { parseLimit, parsePairCursor, requireTxHash, rowLt } from '../lib/params.js';
import { memo } from '../lib/ttl.js';
import { computeFee } from '../views.js';

type ListQuery = { Querystring: Record<string, unknown> };
type HashParams = { Params: { hash: string } };

export function registerTxRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<ListQuery>('/txs', async (req, reply) => {
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);

    const list = async (): Promise<Paginated<TxSummary>> => {
      const rows = await ctx.db
        .select()
        .from(transactions)
        .where(
          cursor
            ? rowLt(transactions.blockNumber, transactions.txIndex, cursor)
            : undefined,
        )
        .orderBy(desc(transactions.blockNumber), desc(transactions.txIndex))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const items = await s.views.toTxSummaries(page);
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? `${last.blockNumber}_${last.txIndex}`
            : null,
      };
    };

    const payload =
      cursor == null ? await memo(`txs:${limit}`, 1000, list) : await list();
    setCache(reply, 'short');
    return payload;
  });

  app.get<HashParams>('/txs/:hash', async (req, reply) => {
    const hash = requireTxHash(req.params.hash);
    const found = await s.cold.ensureTx(hash);
    if (!found) throw notFound();
    const { row, ephemeral, hydrated } = found;
    // Hydration guarantees full detail on served responses; a slim value
    // here means the hydrate raced a demotion — no partial detail, ever.
    if (
      row.input == null ||
      row.blockHash == null ||
      row.nonce == null ||
      row.type == null ||
      row.gas == null
    ) {
      throw new ApiHttpError(502, 'upstream tx unavailable');
    }

    const [decode, transferRows, logRows, indexedHead] = await Promise.all([
      s.decode.decodeTx(row.methodId, row.input),
      ephemeral
        ? Promise.resolve(
            (ephemeral.transfers as TokenTransferRow[])
              .filter((t) => t.txHash === hash)
              .sort((a, b) => a.logIndex - b.logIndex),
          )
        : ctx.db
            .select()
            .from(tokenTransfers)
            .where(eq(tokenTransfers.txHash, hash))
            .orderBy(asc(tokenTransfers.logIndex)),
      ephemeral
        ? Promise.resolve(
            (ephemeral.logs as LogRow[])
              .filter((l) => l.txHash === hash)
              .sort((a, b) => a.logIndex - b.logIndex),
          )
        : ctx.db
            .select()
            .from(logs)
            .where(eq(logs.txHash, hash))
            .orderBy(asc(logs.logIndex)),
      s.heads.indexedHead(),
    ]);

    const [transfers, labelMap] = await Promise.all([
      s.views.toTransferViews(transferRows),
      s.meta.resolveLabels([
        row.from,
        ...(row.to ? [row.to] : []),
        ...logRows.map((l) => l.address),
      ]),
    ]);

    const confirmations =
      Math.max(indexedHead, row.blockNumber) - row.blockNumber + 1;
    // 'immutable' requires the decode to be definitive (resolved or a DB
    // negative) — a transient openchain failure must not be frozen forever.
    // Hydrated slim-tier responses are deterministic from chain, so they
    // cache like persisted rows; only genuinely near-head ephemerals stay
    // short.
    setCache(
      reply,
      confirmations >= ctx.env.CONFIRM_DEPTH &&
        decode.definitive &&
        (!ephemeral || hydrated)
        ? 'immutable'
        : 'short',
    );

    const detail: TxDetail = {
      hash: row.hash,
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      txIndex: row.txIndex,
      timestamp: row.timestamp,
      confirmations,
      from: { address: row.from, label: labelMap.get(row.from) ?? null },
      to: row.to
        ? { address: row.to, label: labelMap.get(row.to) ?? null }
        : null,
      contractAddress: row.contractAddress,
      value: row.value,
      nonce: row.nonce,
      type: row.type,
      status: row.status,
      gasLimit: row.gas,
      gasUsed: row.gasUsed,
      gasUsedForL1: row.gasUsedForL1,
      effectiveGasPrice: row.effectiveGasPrice,
      maxFeePerGas: row.maxFeePerGas,
      maxPriorityFeePerGas: row.maxPriorityFeePerGas,
      fee: computeFee(row.gasUsed, row.effectiveGasPrice),
      input: row.input,
      decoded: decode.decoded,
      transfers,
      logs: logRows.map((l) => ({
        logIndex: l.logIndex,
        address: { address: l.address, label: labelMap.get(l.address) ?? null },
        topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter(
          (t): t is string => t != null,
        ),
        data: l.data,
      })),
    };
    return detail;
  });
}
