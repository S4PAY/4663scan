import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ChainStatus, LiveFeed, Paginated, TxSummary } from '@4663scan/shared/api-types';
import { groupThousands } from '@4663scan/shared/format';
import { LoadMore } from '@/components/LoadMore';
import { TxTable } from '@/components/TxTable';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

export const metadata: Metadata = { title: 'Transactions' };

/**
 * First page (no cursor) reads from /v1/feed — see blocks/page.tsx for the
 * full rationale (same live-RPC path the home page uses, same handoff
 * design). The handoff cursor's blockNumber half is shared with the blocks
 * page's cutoff (Math.min(indexedBlock+1, oldestLiveBlock)) so both lists
 * transition to indexed history at the same boundary; txIndex 0 with a
 * strictly-less-than comparison excludes that boundary block entirely,
 * which is safe (indexed history still starts exactly at indexedBlock)
 * rather than trying to resume mid-block without knowing its last live
 * txIndex.
 */
export default async function TxsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const cursor = firstParam((await searchParams).cursor);

  if (cursor == null) {
    let feed: LiveFeed;
    let status: ChainStatus | null;
    try {
      const [feedR, statusR] = await Promise.allSettled([
        apiGet<LiveFeed>('/feed', { revalidate: 1 }),
        apiGet<ChainStatus>('/status', { revalidate: 1 }),
      ]);
      if (feedR.status === 'rejected') throw feedR.reason;
      feed = feedR.value;
      status = statusR.status === 'fulfilled' ? statusR.value : null;
    } catch (err) {
      if (isClientError(err)) notFound();
      throw err;
    }

    const oldestLiveBlock = feed.blocks[feed.blocks.length - 1]?.number;
    const boundary =
      status != null && oldestLiveBlock != null
        ? Math.min(status.indexedBlock + 1, oldestLiveBlock)
        : null;
    const nextCursor = boundary != null ? `${boundary}_0` : null;

    return (
      <div>
        <h1 className="mb-4 text-lg font-semibold">Transactions</h1>
        <TxTable txs={feed.txs} emptyText="No transactions available." />
        {status != null && oldestLiveBlock != null && (
          <p className="mt-3 text-xs text-muted">
            Older transactions continue from indexed history at block #
            {groupThousands(String(status.indexedBlock))} — currently ~
            {groupThousands(String(Math.max(0, oldestLiveBlock - status.indexedBlock)))}{' '}
            blocks behind the live tip.
          </p>
        )}
        <LoadMore basePath="/txs" cursor={nextCursor} />
      </div>
    );
  }

  const qs = `&cursor=${encodeURIComponent(cursor)}`;
  let page: Paginated<TxSummary>;
  try {
    page = await apiGet<Paginated<TxSummary>>(`/txs?limit=25${qs}`, {
      revalidate: 1,
    });
  } catch (err) {
    // A mangled ?cursor= is client input, not an API outage.
    if (isClientError(err)) notFound();
    throw err;
  }

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Transactions</h1>
      <TxTable txs={page.items} emptyText="No transactions indexed yet." />
      <LoadMore basePath="/txs" cursor={page.nextCursor} />
    </div>
  );
}
