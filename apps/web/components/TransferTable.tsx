import type { TokenTransferView } from '@4663scan/shared/api-types';
import { Age } from './Age';
import { AddressLink } from './AddressLink';
import { StockBadge } from './badges';
import { DataTable, EmptyState, Td } from './DataTable';
import { MobileCard, MobileList } from './MobileRow';
import { TxLink } from './links';
import { TokenAmount } from './values';

export function TransferTable({
  transfers,
  emptyText = 'No token transfers found.',
}: {
  transfers: TokenTransferView[];
  emptyText?: string;
}) {
  if (transfers.length === 0) return <EmptyState>{emptyText}</EmptyState>;
  return (
    <>
      <div className="hidden sm:block">
        <DataTable head={['Tx', 'Age', 'From / To', 'Amount']}>
          {transfers.map((t) => (
            <tr key={`${t.txHash}-${t.logIndex}`}>
              <Td label="Tx">
                <TxLink hash={t.txHash} />
              </Td>
              <Td label="Age">
                <Age timestamp={t.timestamp} />
              </Td>
              <Td label="From / To">
                <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <AddressLink address={t.from.address} label={t.from.label} />
                  <span className="text-muted">→</span>
                  <AddressLink address={t.to.address} label={t.to.label} />
                </span>
              </Td>
              <Td label="Amount">
                <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                  <TokenAmount value={t.value} token={t.token} />
                  {t.token.isStockToken && <StockBadge />}
                </span>
              </Td>
            </tr>
          ))}
        </DataTable>
      </div>

      <MobileList>
        {transfers.map((t) => (
          <MobileCard key={`${t.txHash}-${t.logIndex}`}>
            <div className="flex min-w-0 items-center gap-1.5">
              <TxLink hash={t.txHash} />
              <span className="ml-auto shrink-0">
                <Age timestamp={t.timestamp} />
              </span>
            </div>
            <div className="mt-1 flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <AddressLink address={t.from.address} label={t.from.label} />
              <span className="text-muted">→</span>
              <AddressLink address={t.to.address} label={t.to.label} />
            </div>
            {t.value !== '0' && (
              <div className="mt-1 flex items-center gap-1.5">
                <TokenAmount value={t.value} token={t.token} />
                {t.token.isStockToken && <StockBadge />}
              </div>
            )}
          </MobileCard>
        ))}
      </MobileList>
    </>
  );
}
