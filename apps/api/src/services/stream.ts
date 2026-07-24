import type { ServerResponse } from 'node:http';
import { asc, inArray } from 'drizzle-orm';
import { NEW_BLOCKS_CHANNEL, type NewBlocksNotification } from '@4663scan/shared/db';
import { blocks, transactions } from '@4663scan/shared/db/schema';
import type { StreamEvent, TxSummary } from '@4663scan/shared/api-types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { setCache } from '../lib/cache.js';
import type { Status } from './status.js';
import type { Views } from '../views.js';

const MAX_CLIENTS = 500;
/**
 * Per-client cap on user-space buffered bytes. A peer that stops reading
 * (zero receive window, dead mobile link) otherwise makes Node buffer every
 * ~100ms block event forever — an OOM vector at 500 clients. At ~50KB/s of
 * events a stuck client hits this cap within ~20s and is dropped.
 */
const MAX_BUFFERED_BYTES = 1_048_576;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function makeStream(ctx: AppContext, status: Status, views: Views) {
  const clients = new Set<ServerResponse>();
  let timers: NodeJS.Timeout[] = [];

  function broadcast(chunk: string): void {
    for (const c of clients) {
      const ok = c.write(chunk);
      if (!ok && c.writableLength >= MAX_BUFFERED_BYTES) {
        // Slow or silently-dead peer: destroy rather than buffer unboundedly.
        clients.delete(c);
        c.destroy();
      }
    }
  }

  async function onNotify(payload: string): Promise<void> {
    if (clients.size === 0) return;
    let numbers: number[];
    try {
      const parsed = JSON.parse(payload) as NewBlocksNotification;
      numbers = (parsed.numbers ?? []).filter((n) => Number.isInteger(n));
    } catch {
      return;
    }
    if (numbers.length === 0) return;
    // Bound a burst notification to the most recent 50 blocks.
    numbers = [...new Set(numbers)].sort((a, b) => a - b).slice(-50);

    const [blockRows, txRows] = await Promise.all([
      ctx.db.select().from(blocks).where(inArray(blocks.number, numbers)),
      ctx.db
        .select()
        .from(transactions)
        .where(inArray(transactions.blockNumber, numbers))
        .orderBy(asc(transactions.blockNumber), asc(transactions.txIndex)),
    ]);
    const summaries = await views.toTxSummaries(txRows);
    const byBlock = new Map<number, TxSummary[]>();
    for (const s of summaries) {
      const list = byBlock.get(s.blockNumber);
      if (list) list.push(s);
      else byBlock.set(s.blockNumber, [s]);
    }
    blockRows.sort((a, b) => a.number - b.number);
    let out = '';
    for (const b of blockRows) {
      const event: StreamEvent = {
        type: 'block',
        block: views.toBlockSummary(b),
        txs: byBlock.get(b.number) ?? [],
      };
      out += sse('block', event);
    }
    if (out) broadcast(out);
  }

  async function broadcastStatus(): Promise<void> {
    if (clients.size === 0) return;
    try {
      const s = await status.getStatus();
      broadcast(sse('status', { type: 'status', status: s } satisfies StreamEvent));
    } catch {
      // Status refresh failures must not kill the interval.
    }
  }

  async function start(): Promise<void> {
    // postgres.js dedicates a separate connection to LISTEN and reconnects it.
    await ctx.sql.listen(NEW_BLOCKS_CHANNEL, (payload) => {
      void onNotify(payload).catch(() => {});
    });
    timers.push(setInterval(() => void broadcastStatus(), 10_000));
    timers.push(setInterval(() => broadcast(': ping\n\n'), 15_000));
  }

  function handle(req: FastifyRequest, reply: FastifyReply): void {
    if (clients.size >= MAX_CLIENTS) {
      setCache(reply, 'no-store');
      void reply
        .code(503)
        .send({ error: 'too many stream clients', statusCode: 503 });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    void status
      .getStatus()
      .then((s) => {
        if (clients.has(res)) {
          res.write(sse('status', { type: 'status', status: s } satisfies StreamEvent));
        }
      })
      .catch(() => {});
    req.raw.on('close', () => {
      clients.delete(res);
    });
  }

  function closeAll(): void {
    for (const t of timers) clearInterval(t);
    timers = [];
    for (const c of clients) {
      try {
        c.end();
      } catch {
        // Socket may already be gone.
      }
    }
    clients.clear();
  }

  return { start, handle, closeAll };
}

export type Stream = ReturnType<typeof makeStream>;
