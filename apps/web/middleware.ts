import { NextResponse, type NextRequest } from 'next/server';

/**
 * Bounded edge caching for tx/block detail HTML: fresh for 5 minutes, then
 * serve-stale-while-revalidating for another 10. Browsers always revalidate.
 *
 * Middleware runs before the response status is known, so this header also
 * lands on 404s (a not-yet-indexed tx hash) and error pages. Explicit
 * s-maxage makes those cacheable at CDNs that honor origin headers (RFC 9111
 * — Cloudflare's short built-in 404 TTLs apply only when the origin sends no
 * caching headers), so the TTL must be short enough that a mis-cached miss
 * heals on its own. Truly immutable, year-long caching belongs at the API
 * layer, which knows the confirmation depth and the response status.
 *
 * Invariant this depends on: /tx and /block have NO loading.tsx. A loading
 * boundary makes Next stream the shell and commit status 200 before
 * notFound() runs, and an edge would then cache that "not found" body as a
 * 200. Without the boundary the response blocks on one local API lookup
 * (~ms) and misses stay real 404s. Keep it that way.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  if (request.method === 'GET') {
    response.headers.set(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=600',
    );
  }
  return response;
}

export const config = {
  matcher: ['/tx/:path*', '/block/:path*'],
};
