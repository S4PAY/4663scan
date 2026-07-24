import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { ApiError } from '@4663scan/shared/api-types';
import { createContext, type AppContext } from './context.js';
import { buildServices, type Services } from './services/index.js';
import { setCache } from './lib/cache.js';
import { ApiHttpError } from './lib/errors.js';
import { clientIp, isTrustedInternal } from './lib/rate-limit.js';
import { registerAddressRoutes } from './routes/addresses.js';
import { registerBlockRoutes } from './routes/blocks.js';
import { registerContractRoutes } from './routes/contracts.js';
import { registerFeedRoutes } from './routes/feed.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerSubmissionRoutes } from './routes/submissions.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerTxRoutes } from './routes/txs.js';

/** General public-API cap: generous enough for normal site usage (the home
 *  feed alone polls ~0.6 rps sustained) plus headroom for real third-party
 *  API consumers, tight enough that a scripted abuser can't turn free,
 *  keyless access into meaningful load. Loopback (this box's own SSR
 *  fetches) is exempt — see isTrustedInternal. */
const PUBLIC_API_MAX = 120;
const PUBLIC_API_WINDOW = '1 minute';

function buildApp(ctx: AppContext, services: Services): {
  app: FastifyInstance;
  endpointCount: () => number;
} {
  const app = Fastify({
    logger: process.stdout.isTTY
      ? {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : { level: 'info' },
    disableRequestLogging: true,
    // Caddy always connects from loopback; without this every request's
    // req.ip would just read "127.0.0.1" regardless of the real visitor,
    // making per-IP rate limiting meaningless. Safe here specifically
    // because the API only ever listens on loopback itself (API_HOST=
    // 127.0.0.1) — Caddy is the only thing that can connect to it, so the
    // X-Forwarded-For chain it sees is one Caddy actually built, not
    // something an external client could inject directly.
    trustProxy: true,
  });

  let endpoints = 0;
  app.addHook('onRoute', (route) => {
    if (route.method === 'GET') endpoints += 1;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    // Not every thrown value is an Error instance — @fastify/rate-limit's
    // errorResponseBuilder return is thrown VERBATIM (a plain
    // { error, statusCode } object, see its index.js), so statusCode/message
    // must be read off the original `err`, not off a re-wrapped `new
    // Error(...)` that would silently discard those fields (this masked
    // every 429 as a 500 until caught by a burst-test against the limiter).
    const errObj = err as { statusCode?: unknown; message?: unknown; error?: unknown } | null;
    const rawStatus = err instanceof ApiHttpError ? err.statusCode : errObj?.statusCode;
    const statusCode =
      typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600
        ? rawStatus
        : 500;
    if (statusCode >= 500) {
      req.log.error(err instanceof Error ? err : new Error(JSON.stringify(err)));
    }
    setCache(reply, 'no-store');
    const message =
      statusCode >= 500
        ? 'internal server error'
        : (typeof errObj?.message === 'string' && errObj.message) ||
          (typeof errObj?.error === 'string' && errObj.error) ||
          'bad request';
    const body: ApiError = { error: message, statusCode };
    void reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    setCache(reply, 'no-store');
    const body: ApiError = { error: 'not found', statusCode: 404 };
    void reply.code(404).send(body);
  });

  return {
    app,
    endpointCount: () => endpoints,
  };
}

async function main(): Promise<void> {
  const ctx = createContext();
  const services = buildServices(ctx);
  const { app, endpointCount } = buildApp(ctx, services);

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: 2 * 1024 * 1024, // 2MB — plenty for a logo, small enough to bound abuse
      files: 1,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: PUBLIC_API_MAX,
    timeWindow: PUBLIC_API_WINDOW,
    keyGenerator: clientIp,
    allowList: (req) => isTrustedInternal(req),
    errorResponseBuilder: (_req, context) => ({
      error: `rate limit exceeded — max ${context.max} requests per ${PUBLIC_API_WINDOW}, try again in ${Math.ceil(context.ttl / 1000)}s`,
      statusCode: 429,
    }),
  });
  await app.register(
    async (v1) => {
      registerStatusRoutes(v1, ctx, services);
      registerBlockRoutes(v1, ctx, services);
      registerTxRoutes(v1, ctx, services);
      registerFeedRoutes(v1, ctx, services);
      registerAddressRoutes(v1, ctx, services);
      registerContractRoutes(v1, ctx, services);
      registerTokenRoutes(v1, ctx, services);
      registerSearchRoutes(v1, ctx, services);
      registerStreamRoutes(v1, ctx, services);
      registerSubmissionRoutes(v1, ctx, services);
    },
    { prefix: '/v1' },
  );

  await services.stream.start();
  await app.listen({ host: ctx.env.API_HOST, port: ctx.env.API_PORT });
  app.log.info(
    `4663scan api on ${ctx.env.API_HOST}:${ctx.env.API_PORT} — ${endpointCount()} endpoints`,
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    void (async () => {
      services.stream.closeAll();
      await app.close().catch(() => {});
      await ctx.sql.end({ timeout: 5 }).catch(() => {});
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
