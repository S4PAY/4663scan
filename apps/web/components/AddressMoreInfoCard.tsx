import { Suspense } from 'react';
import type {
  AddressRef,
  AddressSummary,
  ChainStatus,
  ContractInfo,
  Paginated,
  TxSummary,
} from '@4663scan/shared/api-types';
import { apiGet } from '@/lib/api';
import { backfillPercent } from '@/lib/backfill';
import { Age } from './Age';
import { AddressLink } from './AddressLink';
import { TxLink } from './links';

function LabelChips({ labels }: { labels: { label: string; category: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l.label} className="badge" title={l.category}>
          {l.label}
        </span>
      ))}
    </div>
  );
}

/** Cheap: the default (newest-first) page of the address's own tx list. */
async function LastActivityRow({ address }: { address: string }) {
  let last: TxSummary | null = null;
  try {
    const page = await apiGet<Paginated<TxSummary>>(`/addresses/${address}/txs?limit=1`, {
      revalidate: 5,
    });
    last = page.items[0] ?? null;
  } catch {
    // leave null — row renders the "no activity" fallback
  }
  return (
    <div>
      <dt>Last activity</dt>
      <dd>
        {last ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Age timestamp={last.timestamp} />
            <span className="text-muted">·</span>
            <TxLink hash={last.hash} />
          </span>
        ) : (
          <span className="text-muted">No indexed activity</span>
        )}
      </dd>
    </div>
  );
}

/**
 * The expensive one: `sort=asc` walks the SAME index from the other end
 * (see routes/addresses.ts), which is fast for a quiet address but can take
 * several seconds on a cold cache for a high-traffic one (measured ~7s for
 * a busy token contract vs ~0.5s for the existing desc default) — isolated
 * in its own Suspense boundary in AddressMoreInfoCard specifically so a
 * slow lookup here never delays the rest of the page.
 */
async function FirstActivityRow({ address }: { address: string }) {
  let first: TxSummary | null = null;
  let status: ChainStatus | null = null;
  const [firstR, statusR] = await Promise.allSettled([
    apiGet<Paginated<TxSummary>>(`/addresses/${address}/txs?limit=1&sort=asc`, {
      revalidate: 30,
    }),
    apiGet<ChainStatus>('/status', { revalidate: 30 }),
  ]);
  if (firstR.status === 'fulfilled') first = firstR.value.items[0] ?? null;
  if (statusR.status === 'fulfilled') status = statusR.value;

  const backfillIncomplete = status != null && !status.backfill.done;
  const pct = status ? backfillPercent(status) : null;
  // Only claim "funded by" when the earliest activity we found was actually
  // money arriving — an address whose first move was itself an outgoing tx
  // or a contract creation has no cheaply-known funder (see routes/
  // addresses.ts comment) — never guess, just omit the row.
  const fundedBy: AddressRef | null =
    first && first.to && first.to.address === address ? first.from : null;

  return (
    <>
      <div>
        <dt>First activity</dt>
        <dd>
          {first ? (
            <>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Age timestamp={first.timestamp} />
                <span className="text-muted">·</span>
                <TxLink hash={first.hash} />
              </span>
              {backfillIncomplete && (
                <div className="mt-0.5 text-xs text-muted">
                  Earliest <em>indexed</em> activity, not necessarily the true first —
                  backfill{pct != null ? ` ${pct}%` : ''} to genesis.
                </div>
              )}
            </>
          ) : (
            <span className="text-muted">No indexed activity</span>
          )}
        </dd>
      </div>
      {fundedBy && (
        <div>
          <dt>Funded by</dt>
          <dd>
            <AddressLink address={fundedBy.address} label={fundedBy.label} />
          </dd>
        </div>
      )}
    </>
  );
}

function FirstActivitySkeleton() {
  return (
    <div>
      <dt>First activity</dt>
      <dd>
        <span className="inline-block h-4 w-32 max-w-full animate-pulse rounded bg-raised" />
      </dd>
    </div>
  );
}

export function AddressMoreInfoCard({
  address,
  summary,
  contract,
}: {
  address: string;
  summary: AddressSummary;
  contract: ContractInfo | null;
}) {
  // summary.labels and contract.labels can legitimately overlap (both read
  // the same address_labels table from different routes) — de-dupe so a
  // contract with a matching label never shows it twice.
  const labelMap = new Map(
    [...summary.labels, ...(contract?.labels ?? [])].map((l) => [l.label, l]),
  );
  const labels = [...labelMap.values()];

  return (
    <div className="card overflow-hidden">
      <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
        More info
      </h2>
      <dl className="detail mt-1">
        {labels.length > 0 && (
          <div>
            <dt>Labels</dt>
            <dd>
              <LabelChips labels={labels} />
            </dd>
          </div>
        )}
        <LastActivityRow address={address} />
        <Suspense fallback={<FirstActivitySkeleton />}>
          <FirstActivityRow address={address} />
        </Suspense>
        {contract?.creator && (
          <>
            <div>
              <dt>Creator</dt>
              <dd>
                <AddressLink address={contract.creator.address} full copy />
              </dd>
            </div>
            <div>
              <dt>Creation tx</dt>
              <dd>
                <TxLink hash={contract.creator.txHash} full />
              </dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}
