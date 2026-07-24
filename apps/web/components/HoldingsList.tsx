import type { HoldingsResponse } from '@4663scan/shared/api-types';
import { StockBadge } from './badges';
import { EmptyState } from './DataTable';
import { TokenAmount } from './values';

/** Shared by the Overview card's summary and the Holdings tab — same fetch
 *  shape, same degraded-state handling, so the two views can never drift. */
export function HoldingsList({ items }: { items: HoldingsResponse['items'] }) {
  if (items.length === 0) return <EmptyState>No token holdings found.</EmptyState>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((h) => (
        <li key={h.token.address} className="card px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">
              <TokenAmount value={h.balance} token={h.token} />
            </span>
            {h.token.isStockToken && <StockBadge />}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {h.token.name ?? h.token.address}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Live balance lookup failed/timed out — items is [] for that reason, not
 *  because holdings are genuinely empty. Never render HoldingsList for this. */
export function HoldingsUnavailable() {
  return (
    <EmptyState>Live balance lookup is temporarily unavailable — refresh to retry.</EmptyState>
  );
}
