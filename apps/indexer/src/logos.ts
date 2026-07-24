import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { stockTokens, type Db } from '@4663scan/shared/db';
import { env } from '@4663scan/shared/env';
import { COMPANY_DOMAINS } from './company-domains.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/indexer/src/../../web/public/token-logos — same box, same
 *  filesystem, one monorepo; Next.js/Caddy serve this directory statically
 *  with no separate deploy step. */
const LOGO_DIR = join(HERE, '..', '..', 'web', 'public', 'token-logos');
const LOGO_SIZE = 256;
const FETCH_TIMEOUT_MS = 10_000;
const RHJ_ASSETS_URL = 'https://api.robinhood.com/rhj/assets';

/**
 * Confirmed live 2026-07-25: EVERY per-asset logoUrl on rhj/assets
 * currently resolves to this exact image (a generic Robinhood feather
 * brand mark, not the named company's logo) — verified by fetching
 * AAPL's, TSLA's and MSFT's distinct logoUrls directly and diffing the
 * bytes (identical). Not a bug in this code; the CDN itself serves one
 * placeholder for every path right now, apparently ahead of per-company
 * assets actually being uploaded there. Used as a single quick-reject
 * check for the ONE-OFF new-token-discovery path, where there's no sibling
 * data to cross-check against; backfillLogos below instead detects this
 * generically (any hash shared across >1 distinct ticker in the same run),
 * so it keeps working even if Robinhood's placeholder image ever changes.
 */
const KNOWN_ROBINHOOD_PLACEHOLDER_HASH =
  '3acff25ee4e8f842d245c315002965c712c7f42f00fff4377e1ad8ce88d78ab1';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Best-effort stock-vs-ETF classification from company-name keywords — not
 * a certified taxonomy, just what's cheaply inferable without a second
 * external data source. Verified against this chain's actual 96-asset
 * registry (2026-07-24): correctly flags every iShares/SPDR/Invesco/Fund/
 * Trust/ETF-named entry as an ETF with zero false positives among the
 * genuine single-company stocks.
 */
const ETF_NAME_PATTERN =
  /\b(ETF|Trust|Fund|iShares|SPDR|Invesco|Vanguard|ProShares|WisdomTree)\b/i;

export function classifyAssetClass(companyName: string | null): 'stock' | 'etf' | null {
  if (companyName == null) return null;
  return ETF_NAME_PATTERN.test(companyName) ? 'etf' : 'stock';
}

interface RhjAsset {
  tokenSymbol?: string;
  logoUrl?: string;
  deployments?: { contractAddress?: string; chainId?: number }[];
}

/**
 * The same asset list the stock registry was originally seeded from
 * (docs/architecture.md, stock-registry.json's own header comment) — each
 * entry carries a logoUrl keyed by the token's own deployment address on
 * this chain. Fetched fresh (not cached to disk) since this only runs on
 * the rare "new stock token discovered" event or the one-shot backfill,
 * never per-pageview.
 */
export async function fetchRhjLogoMap(): Promise<Map<string, string>> {
  const res = await fetch(RHJ_ASSETS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`rhj/assets responded ${res.status}`);
  const body = (await res.json()) as { assets?: RhjAsset[] };
  const map = new Map<string, string>();
  for (const asset of body.assets ?? []) {
    const deployment = asset.deployments?.find((d) => d.chainId === env.CHAIN_ID);
    if (deployment?.contractAddress && asset.logoUrl) {
      map.set(deployment.contractAddress.toLowerCase(), asset.logoUrl);
    }
  }
  return map;
}

/** Raw bytes or null — never throws; every caller treats a missing logo as
 *  routine, not exceptional. */
async function fetchRawBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Google's public favicon service — no key, no signup, still resolving
 * live (Clearbit's equivalent free API sunset 2025-12-01). Confirmed live:
 * a real domain with a real favicon returns 200 with distinct per-domain
 * bytes; an unknown/nonexistent domain or one with no favicon returns a
 * clean 404 (not a silent generic-image fallback like rhj/assets), so a
 * plain ok-check is enough here — no hash-collision detection needed for
 * this source specifically.
 */
async function fetchCompanyFavicon(ticker: string): Promise<Buffer | null> {
  const domain = COMPANY_DOMAINS[ticker];
  if (!domain) return null;
  return fetchRawBytes(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`,
  );
}

/** Normalizes to a square transparent-pad webp — the only format anything
 *  gets saved as, regardless of source. */
async function normalizeToWebp(raw: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(LOGO_SIZE, LOGO_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 90 })
    .toBuffer();
}

async function saveLogo(
  db: Db,
  logger: Logger,
  tokenAddress: string,
  raw: Buffer,
  source: 'robinhood-rhj-assets' | 'favicon-google',
): Promise<boolean> {
  try {
    const webp = await normalizeToWebp(raw);
    await mkdir(LOGO_DIR, { recursive: true });
    const filename = `${tokenAddress}.webp`;
    await writeFile(join(LOGO_DIR, filename), webp);
    await db
      .update(stockTokens)
      .set({
        logoPath: `/token-logos/${filename}`,
        logoSource: source,
        logoFetchedAt: new Date(),
      })
      .where(eq(stockTokens.tokenAddress, tokenAddress));
    logger.info({ tokenAddress, source }, 'stock token logo fetched');
    return true;
  } catch (err) {
    logger.warn({ tokenAddress, err }, 'stock token logo save failed');
    return false;
  }
}

/**
 * Idempotent: no-ops if this token already has a stored logo. Never
 * throws — a logo is presentational, so a failure here must not disrupt
 * the caller's own (indexer-critical) discovery flow; failures are logged
 * and simply leave logoPath null for the fallback monogram tile to cover.
 * Tries rhj/assets first (rejecting the known generic placeholder), then
 * the company-domain favicon fallback.
 */
export async function ensureLogoFetched(
  db: Db,
  logger: Logger,
  tokenAddress: string,
  ticker: string,
  logoUrl: string | undefined,
): Promise<void> {
  try {
    const existing = await db
      .select({ logoPath: stockTokens.logoPath })
      .from(stockTokens)
      .where(eq(stockTokens.tokenAddress, tokenAddress))
      .limit(1);
    if (existing[0]?.logoPath) return;

    if (logoUrl) {
      const raw = await fetchRawBytes(logoUrl);
      if (raw && sha256(raw) !== KNOWN_ROBINHOOD_PLACEHOLDER_HASH) {
        if (await saveLogo(db, logger, tokenAddress, raw, 'robinhood-rhj-assets')) return;
      }
    }
    const favicon = await fetchCompanyFavicon(ticker);
    if (favicon) {
      await saveLogo(db, logger, tokenAddress, favicon, 'favicon-google');
    }
  } catch (err) {
    logger.warn({ tokenAddress, err }, 'stock token logo fetch failed; leaving unset for the fallback tile');
  }
}

/**
 * One-shot backfill: every stock token missing a logo. Fetches every
 * candidate rhj/assets image FIRST, then rejects any content hash shared
 * by more than one distinct ticker — a generic placeholder served for
 * every path (see this file's header) is exactly that pattern, and
 * detecting it this way needs no hardcoded signature. Tokens whose
 * rhj/assets image was rejected or missing fall back to the company-domain
 * favicon service. Also backfills assetClass for any row that doesn't have
 * one yet (cheap, no network).
 */
export async function backfillLogos(
  db: Db,
  logger: Logger,
): Promise<{
  fetchedRhj: number;
  fetchedFavicon: number;
  failed: number;
  skipped: number;
  classified: number;
  rejectedGenericRhj: number;
}> {
  const logoMap = await fetchRhjLogoMap();
  const rows = await db
    .select({
      tokenAddress: stockTokens.tokenAddress,
      ticker: stockTokens.ticker,
      logoPath: stockTokens.logoPath,
      companyName: stockTokens.companyName,
      assetClass: stockTokens.assetClass,
    })
    .from(stockTokens);

  let classified = 0;
  for (const row of rows) {
    if (row.assetClass == null) {
      const assetClass = classifyAssetClass(row.companyName);
      if (assetClass) {
        await db
          .update(stockTokens)
          .set({ assetClass })
          .where(eq(stockTokens.tokenAddress, row.tokenAddress));
        classified += 1;
      }
    }
  }

  const candidates = rows.filter((r) => r.logoPath == null);
  const skipped = rows.length - candidates.length;

  // Phase 1: fetch every rhj/assets candidate image up front.
  const rhjResults = new Map<string, Buffer>();
  for (const row of candidates) {
    const url = logoMap.get(row.tokenAddress);
    if (!url) continue;
    const raw = await fetchRawBytes(url);
    if (raw) rhjResults.set(row.tokenAddress, raw);
  }

  // Phase 2: any hash shared by more than one distinct token is a generic
  // fallback image, not a real per-company logo — reject all of them.
  const hashCounts = new Map<string, number>();
  const hashByAddress = new Map<string, string>();
  for (const [address, raw] of rhjResults) {
    const hash = sha256(raw);
    hashByAddress.set(address, hash);
    hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
  }
  let rejectedGenericRhj = 0;

  // Phase 3: save the accepted rhj images, then try the favicon fallback
  // for everything else.
  let fetchedRhj = 0;
  let fetchedFavicon = 0;
  let failed = 0;
  for (const row of candidates) {
    const raw = rhjResults.get(row.tokenAddress);
    const hash = hashByAddress.get(row.tokenAddress);
    if (raw && hash && (hashCounts.get(hash) ?? 0) === 1) {
      if (await saveLogo(db, logger, row.tokenAddress, raw, 'robinhood-rhj-assets')) {
        fetchedRhj += 1;
        continue;
      }
    } else if (raw) {
      rejectedGenericRhj += 1;
      logger.warn(
        { tokenAddress: row.tokenAddress, ticker: row.ticker },
        'rhj/assets logo matched a generic placeholder shared by other tickers; trying favicon fallback',
      );
    }
    const favicon = await fetchCompanyFavicon(row.ticker);
    if (favicon && (await saveLogo(db, logger, row.tokenAddress, favicon, 'favicon-google'))) {
      fetchedFavicon += 1;
    } else {
      failed += 1;
    }
  }

  return { fetchedRhj, fetchedFavicon, failed, skipped, classified, rejectedGenericRhj };
}
