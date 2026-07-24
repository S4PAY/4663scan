import type { FastifyReply } from 'fastify';

export type CachePolicy = 'immutable' | 'short' | 'status' | 'no-store';

const HEADERS: Record<CachePolicy, string> = {
  immutable: 'public, max-age=31536000, immutable',
  short: 'public, max-age=1, stale-while-revalidate=2',
  status: 'public, max-age=1',
  'no-store': 'no-store',
};

export function setCache(reply: FastifyReply, policy: CachePolicy): void {
  void reply.header('cache-control', HEADERS[policy]);
}
