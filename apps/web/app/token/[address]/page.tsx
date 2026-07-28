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

interface SocialLink {
  url: string;
  label: string;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Community-submission `socials` is freeform text (e.g. "X: https://…,
 *  Telegram: https://…", or just bare comma-separated URLs per the
 *  submission form's own placeholder) — split on line/comma boundaries and
 *  pull one URL per segment, using any text before it as a label (falling
 *  back to the hostname when a segment is a bare URL). */
function parseSocialLinks(text: string): SocialLink[] {
  const links: SocialLink[] = [];
  for (const segment of text.split(/[\n,]+/)) {
    const match = segment.match(/https?:\/\/\S+/);
    if (!match || match.index == null) continue;
    const url = match[0];
    const prefix = segment.slice(0, match.index).replace(/[:\s]+$/, '').trim();
    links.push({ url, label: prefix || hostnameOf(url) });
  }
  return links;
}

/** Icon choice is by hostname/label match against known platforms, with a
 *  generic globe fallback for anything else — so an unrecognized service
 *  (Discord, TikTok, whatever a submitter adds next) still renders, not a
 *  hard requirement on exactly "website/X/Telegram". */
function socialIconKind(link: SocialLink): 'x' | 'telegram' | 'other' {
  const host = hostnameOf(link.url);
  const label = link.label.toLowerCase();
  if (host === 'x.com' || host === 'twitter.com' || label === 'x' || label.includes('twitter')) {
    return 'x';
  }
  if (host === 't.me' || host.endsWith('.telegram.org') || label.includes('telegram')) {
    return 'telegram';
  }
  return 'other';
}

/** Matches Footer's icon treatment: fill-current SVG, no visible label text
 *  (icons only), aria-label carries the accessible name instead. */
function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current">
      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
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
            <div className="mt-2 flex items-center gap-3">
              {token.community.website && (
                <a
                  href={token.community.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Website"
                  className="navlink"
                >
                  <GlobeIcon />
                </a>
              )}
              {token.community.socials &&
                parseSocialLinks(token.community.socials).map((link) => {
                  const kind = socialIconKind(link);
                  return (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={link.label || 'Social link'}
                      className="navlink"
                    >
                      {kind === 'x' ? (
                        <XIcon />
                      ) : kind === 'telegram' ? (
                        <TelegramIcon />
                      ) : (
                        <GlobeIcon />
                      )}
                    </a>
                  );
                })}
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
