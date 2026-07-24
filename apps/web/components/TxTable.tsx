import type { TxSummary } from '@4663scan/shared/api-types';
import { Age } from './Age';
import { AddressLink } from './AddressLink';
import { MethodChip, StatusBadge } from './badges';
import { DataTable, EmptyState, Td } from './DataTable';
import { MobileCard, MobileList } from './MobileRow';
import { BlockLink, TxLink } from './links';
import { EthValue } from './values';

function FromTo({ tx }: { tx: TxSummary }) {
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <AddressLink address={tx.from.address} label={tx.from.label} />
      <span className="text-muted">→</span>
      {tx.to ? (
        <AddressLink address={tx.to.address} label={tx.to.label} />
      ) : tx.contractAddress ? (
        <>
          <AddressLink address={tx.contractAddress} />
          <span className="text-xs text-muted">(created)</span>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
    </span>
  );
}

export function TxTable({
  txs,
  hideBlock = false,
  emptyText = 'No transactions found.',
}: {
  txs: TxSummary[];
  hideBlock?: boolean;
  emptyText?: string;
}) {
  if (txs.length === 0) return <EmptyState>{emptyText}</EmptyState>;
  const head = ['Tx', 'Method', ...(hideBlock ? [] : ['Block']), 'Age', 'From / To', 'Value'];
  return (
    <>
      <div className="hidden sm:block">
        <DataTable head={head}>
          {txs.map((tx) => (
            <tr key={tx.hash}>
              <Td label="Tx">
                <span className="inline-flex items-center gap-1.5">
                  <TxLink hash={tx.hash} />
                  {tx.status === 0 && <StatusBadge status={0} />}
                </span>
              </Td>
              <Td label="Method">
                <MethodChip name={tx.methodName} id={tx.methodId} />
              </Td>
              {!hideBlock && (
                <Td label="Block">
                  <BlockLink number={tx.blockNumber} />
                </Td>
              )}
              <Td label="Age">
                <Age timestamp={tx.timestamp} />
              </Td>
              <Td label="From / To">
                <FromTo tx={tx} />
              </Td>
              <Td label="Value">
                <EthValue wei={tx.value} maxFrac={5} />
              </Td>
            </tr>
          ))}
        </DataTable>
      </div>

      {/* Mobile: line 1 hash + method (+ block) + age; line 2 from → to;
          line 3 value only when non-zero — not every column labeled and
          stacked (M10 Part 2). */}
      <MobileList>
        {txs.map((tx) => (
          <MobileCard key={tx.hash}>
            <div className="flex min-w-0 items-center gap-1.5">
              <TxLink hash={tx.hash} />
              {tx.status === 0 && <StatusBadge status={0} />}
              <MethodChip name={tx.methodName} id={tx.methodId} />
              {!hideBlock && <BlockLink number={tx.blockNumber} />}
              <span className="ml-auto shrink-0">
                <Age timestamp={tx.timestamp} />
              </span>
            </div>
            <div className="mt-1">
              <FromTo tx={tx} />
            </div>
            {tx.value !== '0' && (
              <div className="mt-1">
                <EthValue wei={tx.value} maxFrac={5} />
              </div>
            )}
          </MobileCard>
        ))}
      </MobileList>
    </>
  );
}
