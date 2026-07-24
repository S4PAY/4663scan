/**
 * Server-side typed fetch wrapper over the local REST API.
 *
 * Caching policy (per spec):
 * - detail lookups pass `cache: 'no-store'` — the API layer owns caching
 *   (immutable Cache-Control for deep blocks/txs);
 * - home/list SSR fetches pass `revalidate` (default 1s) so the Next data
 *   cache absorbs request bursts without going stale.
 */
export const API_BASE: string = process.env.API_URL ?? 'http://localhost:4663';

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = 'NotFoundError';
  }
}

/** API rejected client-supplied input (bad cursor, out-of-range id, …). */
export class BadRequestError extends Error {
  constructor(path: string, status: number) {
    super(`API rejected request (${status}): ${path}`);
    this.name = 'BadRequestError';
  }
}

/**
 * True for errors caused by the request itself (missing resource or garbage
 * input). Pages should map these to notFound() instead of letting them reach
 * the retry-suggesting error boundary — retrying can never succeed.
 */
export function isClientError(err: unknown): boolean {
  return err instanceof NotFoundError || err instanceof BadRequestError;
}

export class ApiUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('API unreachable — is `pnpm dev` running?', { cause });
    this.name = 'ApiUnreachableError';
  }
}

export interface ApiGetOptions {
  /** Seconds for Next data-cache revalidation (list/home fetches). */
  revalidate?: number;
  /** Set to 'no-store' for detail lookups. */
  cache?: 'no-store';
}

export async function apiGet<T>(path: string, opts: ApiGetOptions = {}): Promise<T> {
  const init: RequestInit & { next?: { revalidate: number } } = opts.cache
    ? { cache: opts.cache }
    : { next: { revalidate: opts.revalidate ?? 1 } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1${path}`, init);
  } catch (err) {
    throw new ApiUnreachableError(err);
  }
  if (res.status === 404) throw new NotFoundError(path);
  if (res.status >= 400 && res.status < 500) throw new BadRequestError(path, res.status);
  if (!res.ok) throw new Error(`API responded ${res.status} for ${path}`);
  return (await res.json()) as T;
}
