import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';

export function registerStreamRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  s: Services,
): void {
  app.get('/stream', (req, reply) => {
    s.stream.handle(req, reply);
  });
}
