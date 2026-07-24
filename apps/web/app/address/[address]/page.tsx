import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type {
  AddressSummary,
  ChainStatus,
  ContractEventLog,
  ContractInfo,
  HoldingsResponse,
  Paginated,
  TokenTransferView,
  TxSummary,
} from '@4663scan/shared/api-types';
import {
  checksum,
  formatEth,
  groupThousands,
  isAddress,
  shortAddress,
} from '@4663scan/shared/format';
import { CopyButton } from '@/components/CopyButton';
import { StockBadge } from '@/components/badges';
import { ContractCodeTab } from '@/components/ContractCodeTab';
import { ContractEventsTab } from '@/components/ContractEventsTab';
import { ContractIdentity } from '@/components/ContractIdentity';
import { ContractReadTab } from '@/components/ContractReadTab';
import { EmptyState } from '@/components/DataTable';
import { LoadMore } from '@/components/LoadMore';
import { TokenLink } from '@/components/links';
import { TransferTable } from '@/components/TransferTable';
import { TxTable } from '@/components/TxTable';
import { TokenAmount } from '@/components/values';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

/**
 * No loading.tsx for this route: a loading boundary makes Next stream the
 * shell and commit status 200 before notFound() runs, turning misses and
 * malformed addresses into soft 404s (see middleware.ts for the same
 * invariant on /tx and /block). The render blocks on local API lookups (~ms).
 */

const BASE_TABS = ['txs', 'transfers', 'tokens'] as const;
const CONTRACT_TABS = ['code', 'read', 'events'] as const;
type Tab = (typeof BASE_TABS)[number] | (typeof CONTRACT_TABS)[number];

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ tab?: string | string[]; cursor?: string | string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: `Address ${shortAddress(checksum(address))}` };
}

/** The indexed tx count is capped upstream; render 10k+ at the cap. */
const TX_COUNT_CAP = 10_000;

const TAB_LABELS: Record<Tab, string> = {
  txs: 'Transactions',
  transfers: 'Token transfers',
  tokens: 'Holdings',
  code: 'Code',
  read: 'Read',
  events: 'Events',
};

export default async function AddressPage({ params, searchParams }: Props) {
  const { address: raw } = await params;
  const sp = await searchParams;
  if (!isAddress(raw)) notFound();
  const address = raw.toLowerCase();
  const cursor = firstParam(sp.cursor);
  const cursorQs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';

  let summary: AddressSummary;
  try {
    summary = await apiGet<AddressSummary>(`/addresses/${address}`, {
      cache: 'no-store',
    });
  } catch (err) {
    if (isClientError(err)) notFound();
    throw err;
  }

  // Contract identity does live RPC (bytecode, proxy slots, token probes) —
  // only fetched for addresses that are actually contracts, not every EOA
  // page view.
  let contract: ContractInfo | null = null;
  if (summary.isContract) {
    try {
      contract = await apiGet<ContractInfo>(`/addresses/${address}/contract`, {
        cache: 'no-store',
      });
    } catch {
      // Identity is a bonus section; the rest of the page still works.
    }
  }

  const tabs: readonly Tab[] = contract ? [...BASE_TABS, ...CONTRACT_TABS] : BASE_TABS;
  const tabParam = firstParam(sp.tab);
  const tab: Tab = tabs.includes(tabParam as Tab) ? (tabParam as Tab) : 'txs';

  const checksummed = checksum(address);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h1 className="text-lg font-semibold">Address</h1>
        <span className="mono break-all text-[13px]">{checksummed}</span>
        <CopyButton text={checksummed} />
      </div>
      {!contract && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {summary.isContract && <span className="badge">Contract</span>}
          {summary.labels.map((l) => (
            <span key={l.label} className="badge" title={l.category}>
              {l.label}
            </span>
          ))}
          {summary.token && (
            <TokenLink address={summary.token.address}>
              <span className="badge badge-green">
                Token{summary.token.symbol ? `: ${summary.token.symbol}` : ''}
              </span>
            </TokenLink>
          )}
          {summary.token?.isStockToken && <StockBadge />}
        </div>
      )}

      <dl className="mb-5 grid grid-cols-2 gap-2 sm:max-w-md">
        <div className="stat-tile">
          <dt>ETH balance</dt>
          <dd>
            {summary.balanceWei != null ? (
              formatEth(summary.balanceWei)
            ) : (
              <span className="text-muted">—</span>
            )}
          </dd>
        </div>
        <div className="stat-tile">
          <dt>Indexed txs</dt>
          <dd>
            {summary.indexedTxCount >= TX_COUNT_CAP
              ? '10k+'
              : groupThousands(String(summary.indexedTxCount))}
          </dd>
        </div>
      </dl>

      {contract && <ContractIdentity info={contract} />}

      <nav className="mb-3 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t}
            href={t === 'txs' ? `/address/${address}` : `/address/${address}?tab=${t}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-accent'
            }`}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {tab === 'txs' && <TxsTab address={address} cursorQs={cursorQs} />}
      {tab === 'transfers' && <TransfersTab address={address} cursorQs={cursorQs} />}
      {tab === 'tokens' && <HoldingsTab address={address} />}
      {tab === 'code' && contract && <ContractCodeTab info={contract} />}
      {tab === 'read' &&
        contract &&
        (contract.source.abi ? (
          <ContractReadTab address={address} abi={contract.source.abi} />
        ) : (
          <EmptyState>Not verified — no ABI available to read from.</EmptyState>
        ))}
      {tab === 'events' && contract && <EventsTab address={address} cursorQs={cursorQs} />}
    </div>
  );
}

async function EventsTab({ address, cursorQs }: { address: string; cursorQs: string }) {
  let page: Paginated<ContractEventLog>;
  try {
    page = await apiGet<Paginated<ContractEventLog>>(
      `/addresses/${address}/contract/events?limit=25${cursorQs}`,
      { cache: 'no-store' },
    );
  } catch (err) {
    if (isClientError(err)) notFound();
    throw err;
  }
  return <ContractEventsTab address={address} page={page} />;
}

async function TxsTab({ address, cursorQs }: { address: string; cursorQs: string }) {
  let page: Paginated<TxSummary>;
  try {
    page = await apiGet<Paginated<TxSummary>>(
      `/addresses/${address}/txs?limit=25${cursorQs}`,
      { revalidate: 1 },
    );
  } catch (err) {
    // A mangled ?cursor= is client input, not an API outage.
    if (isClientError(err)) notFound();
    throw err;
  }
  return (
    <>
      <TxTable txs={page.items} emptyText="No transactions in the indexed range." />
      <LoadMore basePath={`/address/${address}`} cursor={page.nextCursor} />
    </>
  );
}

async function TransfersTab({ address, cursorQs }: { address: string; cursorQs: string }) {
  let page: Paginated<TokenTransferView>;
  try {
    page = await apiGet<Paginated<TokenTransferView>>(
      `/addresses/${address}/transfers?limit=25${cursorQs}`,
      { revalidate: 1 },
    );
  } catch (err) {
    if (isClientError(err)) notFound();
    throw err;
  }
  // The retention window is an env knob (HOT_WINDOW_SECONDS); read it from
  // /status so the note stays honest when ops tunes it. Degrade wordlessly.
  let windowNote = 'a limited recent window';
  try {
    const status = await apiGet<ChainStatus>('/status', { revalidate: 60 });
    if (status.tiering) {
      const days = status.tiering.hotWindowSeconds / 86_400;
      const rounded = Number.isInteger(days) ? String(days) : days.toFixed(1);
      windowNote = `a rolling ~${rounded}-day window`;
    }
  } catch {
    // Footer handles API-down states; keep the generic wording here.
  }
  return (
    <>
      <p className="mb-3 text-xs text-muted">
        Stock-token transfers are kept for the full indexed history. Transfers
        of other tokens are kept for {windowNote} by design.
      </p>
      <TransferTable
        transfers={page.items}
        emptyText="No token transfers in the indexed range."
      />
      <LoadMore
        basePath={`/address/${address}`}
        cursor={page.nextCursor}
        params={{ tab: 'transfers' }}
      />
    </>
  );
}

async function HoldingsTab({ address }: { address: string }) {
  const { items, degraded } = await apiGet<HoldingsResponse>(
    `/addresses/${address}/tokens`,
    { revalidate: 1 },
  );
  if (degraded) {
    return (
      <EmptyState>
        Live balance lookup is temporarily unavailable — refresh to retry.
      </EmptyState>
    );
  }
  if (items.length === 0) {
    return <EmptyState>No token holdings found.</EmptyState>;
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((h) => (
        <li key={h.token.address} className="card px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">
              <TokenAmount value={h.balance} token={h.token} />
            </span>
            {h.token.isStockToken && <StockBadge />}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {h.token.name ?? h.token.address}
          </div>
        </li>
      ))}
    </ul>
  );
}
