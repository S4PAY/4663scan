import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Paginated, TokenInfo } from '@4663scan/shared/api-types';
import { groupThousands } from '@4663scan/shared/format';
import { DataTable, EmptyState, SectionTitle, Td } from '@/components/DataTable';
import { LoadMore } from '@/components/LoadMore';
import { BlockLink, TokenLink } from '@/components/links';
import { TokenLogo } from '@/components/TokenLogo';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

export const metadata: Metadata = { title: 'Tokens' };

/** The indexed transfer count is capped upstream (sentinel 100,001); render 100k+ at the cap. */
const TRANSFER_COUNT_CAP = 100_000;

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; cursor?: string | string[] }>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q)?.trim() || undefined;
  const cursor = firstParam(sp.cursor);
  // The stock grid is heavy; show it only on the unfiltered first page.
  const showStocks = !q && !cursor;

  const listQs = [
    'limit=50',
    q ? `q=${encodeURIComponent(q)}` : '',
    cursor ? `cursor=${encodeURIComponent(cursor)}` : '',
  ]
    .filter(Boolean)
    .join('&');

  const [stocksR, allR] = await Promise.allSettled([
    showStocks
      ? apiGet<Paginated<TokenInfo>>('/tokens?stock=true&limit=100', { revalidate: 1 })
      : Promise.resolve(null),
    apiGet<Paginated<TokenInfo>>(`/tokens?${listQs}`, { revalidate: 1 }),
  ]);
  if (allR.status === 'rejected') {
    // A mangled ?cursor= is client input, not an API outage.
    if (isClientError(allR.reason)) notFound();
    throw allR.reason;
  }
  const all = allR.value;
  const stocks =
    stocksR.status === 'fulfilled' && stocksR.value
      ? [...stocksR.value.items].sort((a, b) =>
          (a.stock?.ticker ?? a.symbol ?? '').localeCompare(
            b.stock?.ticker ?? b.symbol ?? '',
          ),
        )
      : [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Tokens</h1>
        <form action="/tokens" method="get" className="ml-auto flex gap-1.5">
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Filter by name / symbol"
            aria-label="Filter tokens"
            className="input w-52 placeholder:font-sans"
          />
          <button type="submit" className="btn">
            Filter
          </button>
        </form>
      </div>

      {showStocks && (
        <>
          <SectionTitle>Stock Tokens</SectionTitle>
          {stocks.length === 0 ? (
            <EmptyState>Indexing tokens… stock tokens will appear here.</EmptyState>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {stocks.map((t) => (
                <li key={t.address}>
                  <Link
                    href={`/token/${t.address}`}
                    className="card flex h-full items-center gap-2.5 px-3 py-2.5 transition-colors hover:border-accent/50"
                  >
                    <TokenLogo
                      logoPath={t.stock?.logoPath ?? null}
                      version={t.stock?.logoFetchedAt}
                      ticker={t.stock?.ticker ?? t.symbol ?? null}
                      size={36}
                    />
                    <div className="min-w-0">
                      <div className="font-mono text-base font-semibold text-accent">
                        {t.stock?.ticker ?? t.symbol ?? '—'}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {t.stock?.companyName ?? t.name ?? t.address}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <SectionTitle>{q ? `Tokens matching “${q}”` : 'All tokens'}</SectionTitle>
      {all.items.length === 0 ? (
        <EmptyState>
          {q ? (
            <>
              No tokens matching “{q}”.{' '}
              <Link href="/tokens" className="text-accent hover:underline">
                Clear filter
              </Link>
            </>
          ) : (
            'Indexing tokens… none discovered yet.'
          )}
        </EmptyState>
      ) : (
        <DataTable head={['Symbol', 'Name', 'Decimals', 'Transfers', 'First seen']}>
          {all.items.map((t) => (
            <tr key={t.address}>
              <Td label="Symbol">
                <TokenLink address={t.address}>{t.symbol ?? '—'}</TokenLink>
              </Td>
              <Td label="Name" className="max-w-64">
                <span className="block truncate">{t.name ?? <span className="text-muted">—</span>}</span>
              </Td>
              <Td label="Decimals" className="tabular-nums">
                {t.decimals ?? <span className="text-muted">—</span>}
              </Td>
              <Td label="Transfers" className="tabular-nums">
                {t.transferCount != null ? (
                  t.transferCount >= TRANSFER_COUNT_CAP ? (
                    '100k+'
                  ) : (
                    groupThousands(String(t.transferCount))
                  )
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
              <Td label="First seen">
                {t.firstSeenBlock != null ? (
                  <BlockLink number={t.firstSeenBlock} />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
      <LoadMore basePath="/tokens" cursor={all.nextCursor} params={{ q }} />
    </div>
  );
}
