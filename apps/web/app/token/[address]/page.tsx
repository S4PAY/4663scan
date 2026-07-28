import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Paginated, TokenInfo, TokenTransferView } from '@4663scan/shared/api-types';
import {
  checksum,
  formatUnitsTrim,
  groupThousands,
  isAddress,
  shortAddress,
} from '@4663scan/shared/format';
import { CopyButton } from '@/components/CopyButton';
import { StockBadge } from '@/components/badges';
import { SectionTitle } from '@/components/DataTable';
import { AddressLink } from '@/components/AddressLink';
import { LoadMore } from '@/components/LoadMore';
import { BlockLink } from '@/components/links';
import { TokenLogo } from '@/components/TokenLogo';
import { TransferTable } from '@/components/TransferTable';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

/**
 * No loading.tsx for this route: a loading boundary makes Next stream the
 * shell and commit status 200 before notFound() runs, turning non-token
 * addresses into soft 404s (see middleware.ts for the same invariant on /tx
 * and /block). The render blocks on local API lookups (~ms).
 */

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}

/** The indexed transfer count is capped upstream (sentinel 100,001); render 100k+ at the cap. */
const TRANSFER_COUNT_CAP = 100_000;

/** Community-submission `socials` is freeform text (e.g. "X: https://…,
 *  Telegram: https://…") — auto-linkify URLs within it rather than
 *  requiring submitters to use a structured format. */
function linkifyText(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="hashlink"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: `Token ${shortAddress(checksum(address))}` };
}

export default async function TokenPage({ params, searchParams }: Props) {
  const { address: raw } = await params;
  const cursor = firstParam((await searchParams).cursor);
  if (!isAddress(raw)) notFound();
  const address = raw.toLowerCase();
  const cursorQs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';

  let token: TokenInfo;
  let transfers: Paginated<TokenTransferView>;
  try {
    [token, transfers] = await Promise.all([
      apiGet<TokenInfo>(`/tokens/${address}`, { cache: 'no-store' }),
      apiGet<Paginated<TokenTransferView>>(
        `/tokens/${address}/transfers?limit=25${cursorQs}`,
        { revalidate: 1 },
      ),
    ]);
  } catch (err) {
    if (isClientError(err)) notFound();
    throw err;
  }

  const checksummed = checksum(address);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* Logo display is keyed on "does a logo exist" (stock.logoPath),
            not on isStockToken — a non-stock token can have a curated logo
            (e.g. our own $4663) without it implying stock-verification
            status. isStockToken still independently gates the fallback
            monogram tile below for stock tokens that haven't been fetched
            yet, so that behavior is unchanged. */}
        {(token.isStockToken || token.stock?.logoPath) && (
          <TokenLogo
            logoPath={token.stock?.logoPath ?? null}
            version={token.stock?.logoFetchedAt}
            ticker={token.stock?.ticker ?? token.symbol ?? null}
            size={40}
          />
        )}
        <h1 className="text-lg font-semibold">
          {token.name ?? shortAddress(checksummed)}
          {token.symbol && <span className="ml-2 text-muted">({token.symbol})</span>}
        </h1>
        {/* Verified-vs-counterfeit stays the headline differentiator — kept
            visually first and unchanged; asset class is a smaller, plain
            tag below, not another competing colored badge. Gated on
            isStockToken specifically (not just "has a stock row"), so a
            non-stock token with a curated logo never shows this. */}
        {token.isStockToken && <StockBadge ticker={token.stock?.ticker} />}
      </div>
      {token.stock &&
        (token.stock.companyName || token.stock.assetClass || token.stock.issuerAddress) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            {token.stock.companyName && <span>{token.stock.companyName}</span>}
            {token.stock.assetClass && (
              <span className="chip uppercase">{token.stock.assetClass}</span>
            )}
            {token.stock.issuerAddress && (
              <span className="inline-flex items-center gap-1.5">
                · issued by <AddressLink address={token.stock.issuerAddress} />
              </span>
            )}
          </div>
        )}

      {token.community && (
        <div className="card mb-5 px-4 py-3 text-[13px]">
          {token.community.description && (
            <p className="text-muted">{token.community.description}</p>
          )}
          {(token.community.website || token.community.socials) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {token.community.website && (
                <a
                  href={token.community.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hashlink break-all"
                >
                  {token.community.website}
                </a>
              )}
              {token.community.socials && (
                <span className="break-all">{linkifyText(token.community.socials)}</span>
              )}
            </div>
          )}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
        <Link href={`/address/${address}`} className="hashlink break-all">
          {checksummed}
        </Link>
        <CopyButton text={checksummed} />
      </div>

      <dl className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div className="stat-tile">
          <dt>Decimals</dt>
          <dd>{token.decimals ?? '—'}</dd>
        </div>
        <div className="stat-tile">
          <dt>Total supply</dt>
          <dd className="truncate">
            {token.totalSupply != null
              ? formatUnitsTrim(token.totalSupply, token.decimals ?? 0)
              : '—'}
          </dd>
        </div>
        <div className="stat-tile">
          <dt>First seen</dt>
          <dd>
            {token.firstSeenBlock != null ? (
              <BlockLink number={token.firstSeenBlock} />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className="stat-tile">
          <dt>Transfers</dt>
          <dd>
            {token.transferCount != null
              ? token.transferCount >= TRANSFER_COUNT_CAP
                ? '100k+'
                : groupThousands(String(token.transferCount))
              : '—'}
          </dd>
        </div>
        <div className="stat-tile">
          <dt>Holders (all-time)</dt>
          <dd>
            {token.holderCount != null
              ? token.holderCount >= TRANSFER_COUNT_CAP
                ? '100k+'
                : groupThousands(String(token.holderCount))
              : '—'}
          </dd>
        </div>
      </dl>

      {token.stock?.chainlinkFeed && (
        <p className="mb-5 text-xs text-muted">
          Chainlink price feed:{' '}
          <AddressLink address={token.stock.chainlinkFeed} copy />
        </p>
      )}

      <SectionTitle>Transfers</SectionTitle>
      <TransferTable
        transfers={transfers.items}
        emptyText="No transfers indexed for this token yet."
      />
      <LoadMore basePath={`/token/${address}`} cursor={transfers.nextCursor} />
    </div>
  );
}
