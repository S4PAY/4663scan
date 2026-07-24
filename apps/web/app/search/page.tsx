import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { SearchResponse, SearchResult } from '@4663scan/shared/api-types';
import { checksum, shortHash } from '@4663scan/shared/format';
import { AddressLink } from '@/components/AddressLink';
import { StockBadge } from '@/components/badges';
import { EmptyState, SectionTitle } from '@/components/DataTable';
import { BlockLink, TokenLink, TxLink } from '@/components/links';
import { apiGet } from '@/lib/api';
import { firstParam } from '@/lib/params';

export const metadata: Metadata = { title: 'Search' };

function urlFor(r: SearchResult): string {
  switch (r.type) {
    case 'tx':
      return `/tx/${r.hash}`;
    case 'block':
      return `/block/${r.number}`;
    case 'address':
      return `/address/${r.address}`;
    case 'token':
      return `/token/${r.address}`;
  }
}

const GROUP_TITLES: Record<SearchResult['type'], string> = {
  tx: 'Transactions',
  block: 'Blocks',
  address: 'Addresses',
  token: 'Tokens',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const query = firstParam(q)?.trim();

  if (!query) {
    return (
      <EmptyState>
        Search for a transaction hash, address, block number or stock ticker.
      </EmptyState>
    );
  }

  const resp = await apiGet<SearchResponse>(
    `/search?q=${encodeURIComponent(query)}`,
    { cache: 'no-store' },
  );

  const first = resp.results[0];
  if (resp.results.length === 1 && first) {
    redirect(urlFor(first));
  }

  if (resp.results.length === 0) {
    return (
      <div>
        <h1 className="mb-4 text-lg font-semibold">Search</h1>
        <EmptyState>
          No results for “<span className="mono break-all">{query}</span>”. Try a tx
          hash, address, block number or ticker.
        </EmptyState>
      </div>
    );
  }

  const groups = (['block', 'tx', 'address', 'token'] as const)
    .map((type) => ({ type, items: resp.results.filter((r) => r.type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">
        Results for “<span className="mono break-all">{query}</span>”
      </h1>
      {groups.map((g) => (
        <section key={g.type}>
          <SectionTitle>{GROUP_TITLES[g.type]}</SectionTitle>
          <ul className="card divide-y divide-border/60">
            {g.items.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
                <ResultRow result={r} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  switch (result.type) {
    case 'tx':
      return <TxLink hash={result.hash} full />;
    case 'block':
      return (
        <>
          <BlockLink number={result.number} grouped />
          <span className="mono text-xs text-muted">{shortHash(result.hash)}</span>
        </>
      );
    case 'address':
      return (
        <>
          <AddressLink address={result.address} full />
          {result.label && <span className="badge">{result.label}</span>}
        </>
      );
    case 'token':
      return (
        <>
          <TokenLink address={result.address}>
            {result.name ?? checksum(result.address)}
            {result.symbol ? ` (${result.symbol})` : ''}
          </TokenLink>
          {result.isStockToken && <StockBadge ticker={result.symbol} />}
        </>
      );
  }
}
