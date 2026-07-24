import { formatEth, formatUnitsTrim, shortAddress } from '@4663scan/shared/format';
import type { TokenRef } from '@4663scan/shared/api-types';
import { TokenLink } from './links';

export function EthValue({
  wei,
  maxFrac = 6,
}: {
  wei: string | null;
  maxFrac?: number;
}) {
  if (wei == null) return <span className="text-muted">—</span>;
  const formatted = formatEth(wei, maxFrac);
  const zero = formatted === '0';
  return (
    <span className={`mono whitespace-nowrap ${zero ? 'text-muted' : ''}`}>
      {formatted} <span className="text-muted">ETH</span>
    </span>
  );
}

export function TokenAmount({ value, token }: { value: string; token: TokenRef }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="mono truncate">
        {formatUnitsTrim(value, token.decimals ?? 0)}
      </span>
      <TokenLink address={token.address}>
        {token.symbol ?? shortAddress(token.address)}
      </TokenLink>
    </span>
  );
}
