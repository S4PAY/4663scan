import type { HoldingsResponse } from '@4663scan/shared/api-types';
import { formatEth } from '@4663scan/shared/format';
import { apiGet } from '@/lib/api';
import { EthUsdValue } from './EthUsdValue';
import { HoldingsList, HoldingsUnavailable } from './HoldingsList';

export async function AddressOverviewCard({
  address,
  balanceWei,
}: {
  address: string;
  balanceWei: string | null;
}) {
  let holdings: HoldingsResponse | null = null;
  try {
    holdings = await apiGet<HoldingsResponse>(`/addresses/${address}/tokens`, {
      revalidate: 1,
    });
  } catch {
    // Live lookup failed outright (not just degraded) — treat the same as
    // the API's own degraded:true, never as "confirmed zero holdings."
  }

  return (
    <div className="card overflow-hidden">
      <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Overview
      </h2>

      <div className="px-4 py-2.5">
        <div className="text-[11px] uppercase tracking-wider text-muted">ETH balance</div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-lg tabular-nums text-accent">
            {balanceWei != null ? formatEth(balanceWei) : '—'}
          </span>
          <EthUsdValue balanceWei={balanceWei} />
        </div>
      </div>

      <div className="border-t border-border/60 px-4 py-2.5">
        {holdings == null || holdings.degraded ? (
          <>
            <div className="text-[11px] uppercase tracking-wider text-muted">
              Token holdings
            </div>
            <HoldingsUnavailable />
          </>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] uppercase tracking-wider text-muted">
              <span>
                Token holdings <span className="text-text">({holdings.items.length})</span>
              </span>
              <span className="text-xs transition-transform group-open:rotate-90">›</span>
            </summary>
            {holdings.items.length > 0 && (
              <div className="mt-2">
                <HoldingsList items={holdings.items} />
              </div>
            )}
          </details>
        )}
      </div>
    </div>
  );
}
