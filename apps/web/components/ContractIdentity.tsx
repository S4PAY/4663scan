import type { ContractInfo } from '@4663scan/shared/api-types';
import { groupThousands } from '@4663scan/shared/format';
import { AddressLink } from './AddressLink';
import { StockBadge } from './badges';
import { TokenLink } from './links';

/**
 * The "Contract & verification" card (M10). Creator/creation-tx moved to
 * AddressMoreInfoCard — this card is specifically about verification
 * status now, not general identity.
 */
export function ContractIdentity({ info }: { info: ContractInfo }) {
  const { source, proxy } = info;
  return (
    <div className="card overflow-hidden">
      <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Contract &amp; verification
      </h2>

      <div className="px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`badge ${source.verified ? 'badge-green' : ''}`}>
            {source.verified ? `Verified${source.name ? `: ${source.name}` : ''}` : 'Unverified'}
          </span>
          {source.verified && source.provider && (
            <span className="text-xs text-muted">
              via {source.provider === 'sourcify' ? 'Sourcify' : 'Blockscout'}
            </span>
          )}
          {info.tokenType && info.token && (
            // The token itself is whatever address is on this page — a proxy's
            // balances/state live in its OWN storage (delegatecall), so a
            // proxied ERC-20's "real" token address is the proxy, not its
            // implementation.
            <TokenLink address={info.token.address}>
              <span className="badge badge-green">
                {info.tokenType.toUpperCase()}
                {info.token.symbol ? `: ${info.token.symbol}` : ''}
              </span>
            </TokenLink>
          )}
          {proxy && (
            <span className="badge">
              {proxy.standard === 'eip1967' ? 'EIP-1967 proxy' : 'EIP-1822 proxy'}
            </span>
          )}
        </div>

        {/* Prominent, per the charter — the differentiator is that this is
            checked against the on-chain StockFactory, not a name match a
            counterfeit could fake. Existing StockBadge + plain text only —
            no new component style. */}
        {info.token?.isStockToken && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <StockBadge ticker={info.token.symbol ?? undefined} />
            <span className="text-muted">
              verified against the on-chain StockFactory — not a name match
            </span>
          </div>
        )}
      </div>

      <dl className="detail">
        <div>
          <dt>Bytecode size</dt>
          <dd>
            <span className="mono">{groupThousands(String(info.codeSize))} bytes</span>
          </dd>
        </div>
        {proxy && (
          <div>
            <dt>Implementation</dt>
            <dd>
              {proxy.implementation ? (
                <AddressLink address={proxy.implementation} full copy />
              ) : (
                <span className="text-muted">—</span>
              )}
            </dd>
          </div>
        )}
        {proxy?.admin && (
          <div>
            <dt>Proxy admin</dt>
            <dd>
              <AddressLink address={proxy.admin} full copy />
            </dd>
          </div>
        )}
        {source.compilerVersion && (
          <div>
            <dt>Compiler</dt>
            <dd>
              <span className="mono text-[13px]">{source.compilerVersion}</span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
