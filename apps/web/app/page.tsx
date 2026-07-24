import type { ChainStatus, LiveFeed } from '@4663scan/shared/api-types';
import { FeedHome } from '@/components/FeedHome';
import { apiGet } from '@/lib/api';

/**
 * Forces per-request rendering instead of Next's default static/ISR
 * optimization. Without this, Next prerenders `/` once and serves that
 * snapshot under stale-while-revalidate semantics (confirmed live:
 * `x-nextjs-cache: STALE` with an effective SWR window of ~1 year) — the
 * revalidate:1 on the fetches below only bounds the underlying data-cache
 * entry, not how long the already-rendered HTML page itself can be served
 * stale while a background regen is pending. force-dynamic removes the
 * Full Route Cache from the picture entirely so every request executes this
 * function fresh; the 1s fetch revalidate below still dedupes concurrent
 * request bursts against the API.
 */
export const dynamic = 'force-dynamic';

/**
 * Home renders its shell even when the API is down (allSettled, no throw);
 * FeedHome then polls /v1/feed client-side and self-heals. /feed reads the
 * current chain tip straight from RPC (see docs/architecture.md) — this
 * chain's indexed DB range trails real time by a large, growing margin on
 * free RPC, so it is not a usable source for "latest".
 */
export default async function HomePage() {
  const [statusR, feedR] = await Promise.allSettled([
    apiGet<ChainStatus>('/status', { revalidate: 1 }),
    apiGet<LiveFeed>('/feed', { revalidate: 1 }),
  ]);
  return (
    <FeedHome
      initialStatus={statusR.status === 'fulfilled' ? statusR.value : null}
      initialFeed={feedR.status === 'fulfilled' ? feedR.value : null}
    />
  );
}
