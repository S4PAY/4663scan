import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type {
  BlockSummary,
  ChainStatus,
  LiveFeed,
  Paginated,
} from '@4663scan/shared/api-types';
import {
  EXECUTION_GAS_LIMIT,
  formatGwei,
  gasPercent,
  groupThousands,
} from '@4663scan/shared/format';
import { Age } from '@/components/Age';
import { DataTable, EmptyState, Td } from '@/components/DataTable';
import { LoadMore } from '@/components/LoadMore';
import { BlockLink } from '@/components/links';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

export const metadata: Metadata = { title: 'Blocks' };

function BlockRow({ b }: { b: BlockSummary }) {
  return (
    <tr>
      <Td label="Block">
        <BlockLink number={b.number} />
      </Td>
      <Td label="Age">
        <Age timestamp={b.timestamp} />
      </Td>
      <Td label="Txs" className="tabular-nums">
        {b.txCount}
      </Td>
      <Td label="Gas used">
        <span className="mono">{groupThousands(String(b.gasUsed))}</span>{' '}
        <span className="text-xs text-muted">
          ({gasPercent(b.gasUsed, EXECUTION_GAS_LIMIT)})
        </span>
      </Td>
      <Td label="Base fee">
        {b.baseFeePerGas != null ? (
          <span className="mono">
            {formatGwei(b.baseFeePerGas)} <span className="text-muted">gwei</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
    </tr>
  );
}

const HEAD = ['Block', 'Age', 'Txs', 'Gas used', 'Base fee'];

/**
 * First page (no cursor) reads from /v1/feed — the same live-RPC,
 * ~2s-memoized path the home page uses — instead of the DB, which trails
 * the real tip by a large, growing margin on free RPC (docs/ops.md). Every
 * later page pages through indexed DB history exactly as before; the
 * handoff cursor jumps straight from the bottom of the live window to
 * indexedBlock rather than trying to RPC-page through the gap between them
 * (currently ~400k blocks) one page at a time — capped with Math.min so it
 * can never overlap rows already shown live, even if indexing ever catches
 * up close to the tip.
 */
export default async function BlocksPage({
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

    const oldestLive = feed.blocks[feed.blocks.length - 1]?.number;
    const nextCursor =
      status != null && oldestLive != null
        ? String(Math.min(status.indexedBlock + 1, oldestLive))
        : null;

    return (
      <div>
        <h1 className="mb-4 text-lg font-semibold">Blocks</h1>
        {feed.blocks.length === 0 ? (
          <EmptyState>No blocks available.</EmptyState>
        ) : (
          <DataTable head={HEAD}>
            {feed.blocks.map((b) => (
              <BlockRow key={b.number} b={b} />
            ))}
          </DataTable>
        )}
        {status != null && oldestLive != null && (
          <p className="mt-3 text-xs text-muted">
            Older blocks continue from indexed history at #
            {groupThousands(String(status.indexedBlock))} — currently ~
            {groupThousands(String(Math.max(0, oldestLive - status.indexedBlock)))}{' '}
            blocks behind the live tip.
          </p>
        )}
        <LoadMore basePath="/blocks" cursor={nextCursor} />
      </div>
    );
  }

  const qs = `&cursor=${encodeURIComponent(cursor)}`;
  let page: Paginated<BlockSummary>;
  try {
    page = await apiGet<Paginated<BlockSummary>>(`/blocks?limit=25${qs}`, {
      revalidate: 1,
    });
  } catch (err) {
    // A mangled ?cursor= is client input, not an API outage.
    if (isClientError(err)) notFound();
    throw err;
  }

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Blocks</h1>
      {page.items.length === 0 ? (
        <EmptyState>No blocks indexed yet.</EmptyState>
      ) : (
        <DataTable head={HEAD}>
          {page.items.map((b) => (
            <BlockRow key={b.number} b={b} />
          ))}
        </DataTable>
      )}
      <LoadMore basePath="/blocks" cursor={page.nextCursor} />
    </div>
  );
}
