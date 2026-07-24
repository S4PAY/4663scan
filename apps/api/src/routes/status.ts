import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';

export function registerStatusRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  s: Services,
): void {
  app.get('/status', async (_req, reply) => {
    const status = await s.status.getStatus();
    setCache(reply, 'status');
    return status;
  });
}
