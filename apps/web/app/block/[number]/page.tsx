import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { BlockDetail, Paginated, TxSummary } from '@4663scan/shared/api-types';
import {
  EXECUTION_GAS_LIMIT,
  formatGwei,
  formatTimestamp,
  gasPercent,
  groupThousands,
  isBlockNumber,
  isHexString,
  shortHash,
} from '@4663scan/shared/format';
import { Age } from '@/components/Age';
import { AddressLink } from '@/components/AddressLink';
import { CopyButton } from '@/components/CopyButton';
import { DetailList, DetailRow, SectionTitle } from '@/components/DataTable';
import { LoadMore } from '@/components/LoadMore';
import { TxTable } from '@/components/TxTable';
import { EthValue } from '@/components/values';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

/** EIP-1559 base-fee burn: gasUsed × baseFeePerGas, wei. Null if no basefee
 *  (pre-1559 block). Both inputs already ride on every block response. */
function burntFees(gasUsed: number, baseFeePerGas: string | null): string | null {
  if (baseFeePerGas == null) return null;
  return (BigInt(gasUsed) * BigInt(baseFeePerGas)).toString();
}

interface Props {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}

/** Digit strings the API would reject anyway (e.g. 30 digits) stay off the wire. */
const isIndexableBlockNumber = (s: string): boolean =>
  isBlockNumber(s) && Number.isSafeInteger(Number(s));

const getBlock = (id: string) =>
  apiGet<BlockDetail>(`/blocks/${id.toLowerCase()}`, { cache: 'no-store' });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { number } = await params;
  return {
    title: isBlockNumber(number) ? `Block #${number}` : `Block ${shortHash(number)}`,
  };
}

export default async function BlockPage({ params, searchParams }: Props) {
  const { number: id } = await params;
  const cursor = firstParam((await searchParams).cursor);

  // /block/0xhash → canonical number URL.
  if (isHexString(id, 32)) {
    let byHash: BlockDetail;
    try {
      byHash = await getBlock(id);
    } catch (err) {
      if (isClientError(err)) notFound();
      throw err;
    }
    redirect(`/block/${byHash.number}`);
  }
  if (!isIndexableBlockNumber(id)) notFound();

  const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  let block: BlockDetail;
  let txPage: Paginated<TxSummary>;
  try {
    [block, txPage] = await Promise.all([
      getBlock(id),
      apiGet<Paginated<TxSummary>>(`/blocks/${id}/txs?limit=25${qs}`, {
        cache: 'no-store',
      }),
    ]);
  } catch (err) {
    // Misses and garbage input (mangled ?cursor=) are both 404s, not outages.
    if (isClientError(err)) notFound();
    throw err;
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">
          Block <span className="mono">#{groupThousands(String(block.number))}</span>
        </h1>
        <span className="ml-auto inline-flex gap-1">
          {block.number > 0 && (
            <Link href={`/block/${block.number - 1}`} className="btn px-2 py-1" title="Previous block">
              ‹
            </Link>
          )}
          {/* Unconditional: gating on a snapshot (e.g. confirmations) bakes a
              missing link into edge-cached HTML. At the tip this may 404 for
              ~100ms until the next block lands — acceptable. */}
          <Link href={`/block/${block.number + 1}`} className="btn px-2 py-1" title="Next block">
            ›
          </Link>
        </span>
      </div>

      <DetailList>
        <DetailRow label="Hash">
          <span className="mono break-all text-[13px]">{block.hash}</span>
          <CopyButton text={block.hash} />
        </DetailRow>
        <DetailRow label="Timestamp">
          <Age timestamp={block.timestamp} />{' '}
          <span className="text-muted">· {formatTimestamp(block.timestamp)}</span>
        </DetailRow>
        <DetailRow label="Confirmations">
          {/* Point-in-time snapshot (~10/s on this chain); edge caching bounds
              its staleness to the middleware's s-maxage=300 window. */}
          <span className="mono">{groupThousands(String(block.confirmations))}</span>
        </DetailRow>
        <DetailRow label="Parent">
          {block.number > 0 ? (
            <Link href={`/block/${block.number - 1}`} className="hashlink break-all" title={block.parentHash}>
              {block.parentHash}
            </Link>
          ) : (
            <span className="mono break-all text-muted">{block.parentHash}</span>
          )}
        </DetailRow>
        <DetailRow label="Transactions">
          <span className="tabular-nums">{block.txCount}</span>
        </DetailRow>
        <DetailRow label="Gas used">
          <span className="mono">{groupThousands(String(block.gasUsed))}</span>{' '}
          <span className="text-muted">
            {/* block.gasLimit itself is Arbitrum's nominal ~2^50 per-block
                figure (L1-cost headroom, not execution capacity) — always
                ~0% of it regardless of real usage. EXECUTION_GAS_LIMIT is
                the actually-enforced execution ceiling; see format.ts. */}
            ({gasPercent(block.gasUsed, EXECUTION_GAS_LIMIT)} of{' '}
            {groupThousands(String(EXECUTION_GAS_LIMIT))})
          </span>
        </DetailRow>
        <DetailRow label="Base fee">
          {block.baseFeePerGas != null ? (
            <span className="mono">
              {formatGwei(block.baseFeePerGas)} <span className="text-muted">gwei</span>
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
        <DetailRow label="Burnt fees">
          <EthValue wei={burntFees(block.gasUsed, block.baseFeePerGas)} maxFrac={8} />
        </DetailRow>
        <DetailRow label="Sequencer">
          <AddressLink address={block.miner} />
        </DetailRow>
        <DetailRow label="L1 block">
          {block.l1BlockNumber != null ? (
            <span className="mono">{groupThousands(String(block.l1BlockNumber))}</span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
        <DetailRow label="Size">
          {block.size != null ? (
            <span className="mono">{groupThousands(String(block.size))} bytes</span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
      </DetailList>

      <SectionTitle>Transactions</SectionTitle>
      <TxTable txs={txPage.items} hideBlock emptyText="No transactions in this block." />
      <LoadMore basePath={`/block/${block.number}`} cursor={txPage.nextCursor} />
    </div>
  );
}
