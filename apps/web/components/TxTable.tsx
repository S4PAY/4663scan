import type { TxSummary } from '@4663scan/shared/api-types';
import { Age } from './Age';
import { AddressLink } from './AddressLink';
import { MethodChip, StatusBadge } from './badges';
import { DataTable, EmptyState, Td } from './DataTable';
import { BlockLink, TxLink } from './links';
import { EthValue } from './values';

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
          </Td>
          <Td label="Value">
            <EthValue wei={tx.value} maxFrac={5} />
          </Td>
        </tr>
      ))}
    </DataTable>
  );
}
