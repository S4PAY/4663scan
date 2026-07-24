import type { ContractInfo } from '@4663scan/shared/api-types';
import { groupThousands } from '@4663scan/shared/format';
import { AddressLink } from './AddressLink';
import { StockBadge } from './badges';
import { DetailList, DetailRow } from './DataTable';
import { TokenLink, TxLink } from './links';

export function ContractIdentity({ info }: { info: ContractInfo }) {
  const { source, proxy } = info;
  return (
    <div className="mb-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
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
        {info.token?.isStockToken && <StockBadge />}
        {proxy && <span className="badge">{proxy.standard === 'eip1967' ? 'EIP-1967 proxy' : 'EIP-1822 proxy'}</span>}
      </div>

      <DetailList>
        <DetailRow label="Bytecode size">
          <span className="mono">{groupThousands(String(info.codeSize))} bytes</span>
        </DetailRow>
        {proxy && (
          <DetailRow label="Implementation">
            {proxy.implementation ? <AddressLink address={proxy.implementation} full copy /> : (
              <span className="text-muted">—</span>
            )}
          </DetailRow>
        )}
        {proxy?.admin && (
          <DetailRow label="Proxy admin">
            <AddressLink address={proxy.admin} full copy />
          </DetailRow>
        )}
        {info.creator && (
          <DetailRow label="Creator">
            <AddressLink address={info.creator.address} full copy />{' '}
            <span className="text-muted">
              · created by <TxLink hash={info.creator.txHash} />
            </span>
          </DetailRow>
        )}
        {source.compilerVersion && (
          <DetailRow label="Compiler">
            <span className="mono text-[13px]">{source.compilerVersion}</span>
          </DetailRow>
        )}
      </DetailList>
    </div>
  );
}
