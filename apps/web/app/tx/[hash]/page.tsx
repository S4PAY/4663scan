import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { TxDetail } from '@4663scan/shared/api-types';
import {
  formatGwei,
  formatTimestamp,
  gasPercent,
  groupThousands,
  isTxHash,
  shortHash,
} from '@4663scan/shared/format';
import { Age } from '@/components/Age';
import { AddressLink } from '@/components/AddressLink';
import { CopyButton } from '@/components/CopyButton';
import { MethodChip, StatusBadge, StockBadge } from '@/components/badges';
import { DetailList, DetailRow, SectionTitle } from '@/components/DataTable';
import { BlockLink } from '@/components/links';
import { RawToggle } from '@/components/RawToggle';
import { EthValue, TokenAmount } from '@/components/values';
import { apiGet, isClientError } from '@/lib/api';

interface Props {
  params: Promise<{ hash: string }>;
}

const getTx = (hash: string) =>
  apiGet<TxDetail>(`/txs/${hash.toLowerCase()}`, { cache: 'no-store' });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  return { title: `Tx ${shortHash(hash)}` };
}

const TYPE_NAMES: Record<number, string> = {
  0: 'legacy',
  1: 'access list',
  2: 'dynamic fee',
  3: 'blob',
};

function txTypeLabel(type: number): string {
  // Arbitrum system tx types are 0x64–0x6a (100–106).
  if (type >= 100) return 'system';
  return TYPE_NAMES[type] ?? String(type);
}

export default async function TxPage({ params }: Props) {
  const { hash } = await params;
  if (!isTxHash(hash)) notFound();

  let tx: TxDetail;
  try {
    tx = await getTx(hash);
  } catch (err) {
    if (isClientError(err)) notFound();
    throw err;
  }

  const methodId = tx.input.length >= 10 ? tx.input.slice(0, 10) : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">Transaction</h1>
        <span className="mono break-all text-[13px] text-muted">{tx.hash}</span>
        <CopyButton text={tx.hash} />
      </div>

      <DetailList>
        <DetailRow label="Status">
          <StatusBadge status={tx.status} />
        </DetailRow>
        <DetailRow label="Timestamp">
          <Age timestamp={tx.timestamp} />{' '}
          <span className="text-muted">· {formatTimestamp(tx.timestamp)}</span>
        </DetailRow>
        <DetailRow label="Block">
          <BlockLink number={tx.blockNumber} />{' '}
          {/* Confirmations are a point-in-time snapshot (~10/s on this chain);
              edge caching bounds staleness to the middleware's s-maxage=300. */}
          <span className="text-muted">
            · {groupThousands(String(tx.confirmations))} confirmation
            {tx.confirmations === 1 ? '' : 's'}
          </span>
        </DetailRow>
        <DetailRow label="From">
          <AddressLink address={tx.from.address} label={tx.from.label} full copy />
        </DetailRow>
        <DetailRow label={tx.to ? 'To' : 'Contract created'}>
          {tx.to ? (
            <AddressLink address={tx.to.address} label={tx.to.label} full copy />
          ) : tx.contractAddress ? (
            <AddressLink address={tx.contractAddress} full copy />
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
        <DetailRow label="Value">
          <EthValue wei={tx.value} maxFrac={18} />
        </DetailRow>
        <DetailRow label="Fee">
          <EthValue wei={tx.fee} maxFrac={12} />
          {tx.gasUsed != null && tx.effectiveGasPrice != null && (
            <span className="ml-2 text-xs text-muted">
              ({groupThousands(String(tx.gasUsed))} gas × {formatGwei(tx.effectiveGasPrice)}{' '}
              gwei)
            </span>
          )}
        </DetailRow>
        <DetailRow label="Nonce">
          <span className="mono">{tx.nonce}</span>
        </DetailRow>
        <DetailRow label="Method">
          {tx.decoded ? (
            <div className="min-w-0">
              <MethodChip name={tx.decoded.name} id={tx.decoded.selector} />
              <span className="ml-2 break-all font-mono text-xs text-muted">
                {tx.decoded.signature}
              </span>
              {tx.decoded.params && tx.decoded.params.length > 0 && (
                <details className="group mt-2">
                  <summary className="cursor-pointer select-none text-[13px] text-muted transition-colors hover:text-accent">
                    <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                      ›
                    </span>
                    Decoded params ({tx.decoded.params.length})
                  </summary>
                  <div className="card mt-1.5 overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <tbody>
                        {tx.decoded.params.map((p, i) => (
                          <tr key={i} className="border-b border-border/60 last:border-b-0">
                            <td className="px-3 py-1.5 align-top font-mono text-muted">
                              {p.name || `arg${i}`}
                            </td>
                            <td className="px-3 py-1.5 align-top font-mono text-xs text-muted">
                              {p.type}
                            </td>
                            <td className="w-full break-all px-3 py-1.5 align-top font-mono">
                              {p.type === 'address' ? (
                                <AddressLink address={p.value} full />
                              ) : (
                                p.value
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          ) : methodId ? (
            <MethodChip name={null} id={methodId} />
          ) : (
            <span className="text-muted">— (plain transfer)</span>
          )}
        </DetailRow>
      </DetailList>

      {tx.transfers.length > 0 && (
        <>
          <SectionTitle>Token transfers ({tx.transfers.length})</SectionTitle>
          <div className="card divide-y divide-border/60">
            {tx.transfers.map((t) => (
              <div
                key={`${t.txHash}-${t.logIndex}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-[13px]"
              >
                <AddressLink address={t.from.address} label={t.from.label} />
                <span className="text-muted">→</span>
                <AddressLink address={t.to.address} label={t.to.label} />
                <span className="ml-auto inline-flex items-center gap-1.5">
                  <TokenAmount value={t.value} token={t.token} />
                  {t.token.isStockToken && <StockBadge />}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Gas</SectionTitle>
      <DetailList>
        <DetailRow label="Gas limit">
          <span className="mono">{groupThousands(tx.gasLimit)}</span>
        </DetailRow>
        <DetailRow label="Gas used">
          {tx.gasUsed != null ? (
            <>
              <span className="mono">{groupThousands(String(tx.gasUsed))}</span>{' '}
              <span className="text-muted">
                ({gasPercent(tx.gasUsed, Number(tx.gasLimit))})
              </span>
              {tx.gasUsedForL1 != null && (
                <span className="ml-2 text-muted">
                  of which L1: <span className="mono">{groupThousands(String(tx.gasUsedForL1))}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
        <DetailRow label="Effective gas price">
          {tx.effectiveGasPrice != null ? (
            <span className="mono">
              {formatGwei(tx.effectiveGasPrice)} <span className="text-muted">gwei</span>
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </DetailRow>
        {tx.maxFeePerGas != null && (
          <DetailRow label="Max fee">
            <span className="mono">
              {formatGwei(tx.maxFeePerGas)} <span className="text-muted">gwei</span>
            </span>
            {tx.maxPriorityFeePerGas != null && (
              <span className="ml-2 text-muted">
                priority {formatGwei(tx.maxPriorityFeePerGas)} gwei
              </span>
            )}
          </DetailRow>
        )}
        <DetailRow label="Type">
          <span className="badge" title={`0x${tx.type.toString(16)}`}>
            {txTypeLabel(tx.type)}
          </span>
        </DetailRow>
      </DetailList>

      {tx.logs.length > 0 && (
        <>
          <SectionTitle>Logs ({tx.logs.length})</SectionTitle>
          <div className="card divide-y divide-border/60">
            {tx.logs.map((log) => (
              <div key={log.logIndex} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">#{log.logIndex}</span>
                  <AddressLink address={log.address.address} label={log.address.label} />
                </div>
                <ol className="mt-2 space-y-1">
                  {log.topics.map((topic, i) => (
                    <li key={i} className="flex gap-2 font-mono text-xs">
                      <span className="shrink-0 text-muted">t{i}</span>
                      <span className={`break-all ${i === 0 ? 'font-semibold text-text' : 'text-muted'}`}>
                        {topic}
                      </span>
                    </li>
                  ))}
                </ol>
                {log.data && log.data !== '0x' && (
                  <div className="mt-2">
                    <RawToggle label="Data" data={log.data} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Raw input</SectionTitle>
      {tx.input && tx.input !== '0x' ? (
        <div className="card px-4 py-3">
          <RawToggle label="Input data" data={tx.input} />
        </div>
      ) : (
        <div className="card px-4 py-3 font-mono text-[13px] text-muted">
          0x <span className="font-sans">(no input)</span>
        </div>
      )}
    </div>
  );
}
