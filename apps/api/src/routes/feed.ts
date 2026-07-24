import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';

export function registerFeedRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  s: Services,
): void {
  app.get('/feed', async (_req, reply) => {
    setCache(reply, 'short');
    return s.feed.getFeed();
  });
}
