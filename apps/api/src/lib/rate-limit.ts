import type { FastifyRequest } from 'fastify';

/**
 * Cloudflare sets this header itself from the actual TCP connection to its
 * edge — unlike X-Forwarded-For, a client can't spoof it by sending its own
 * copy (Cloudflare's edge overwrites it before forwarding), so it's the
 * right source of truth for per-IP rate limiting behind Cloudflare's proxy.
 * Falls back to Fastify's own `request.ip` (see trustProxy in main.ts) for
 * direct/local traffic that never passes through Cloudflare (dev, health
 * checks, this box's own loopback SSR fetches).
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  return req.ip;
}

/**
 * This box's own Next.js SSR fetches go straight to loopback (API_URL=
 * http://127.0.0.1 in .env), bypassing Caddy/Cloudflare entirely — that's
 * first-party traffic serving real page loads, not the public API surface
 * this rate limit exists to protect against, so every SSR request would
 * otherwise share one IP bucket (127.0.0.1) that real site traffic could
 * exhaust on its own. Exempt rather than rate-limited.
 */
export function isTrustedInternal(req: FastifyRequest): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1';
}
