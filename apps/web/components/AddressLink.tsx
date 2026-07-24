import Link from 'next/link';
import { checksum, shortAddress } from '@4663scan/shared/format';
import { CopyButton } from './CopyButton';

/**
 * Renders an AddressRef: label badge when labeled, otherwise a checksummed
 * short (or full) mono address. Always links to /address/:address.
 */
export function AddressLink({
  address,
  label,
  copy = false,
  full = false,
}: {
  address: string;
  label?: string | null;
  copy?: boolean;
  full?: boolean;
}) {
  const checksummed = checksum(address);
  const href = `/address/${address.toLowerCase()}`;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center align-middle">
      {label ? (
        <Link href={href} title={checksummed} className="badge max-w-full transition-colors hover:border-accent/50 hover:text-accent">
          <span className="truncate">{label}</span>
        </Link>
      ) : (
        <Link
          href={href}
          title={checksummed}
          className={`hashlink ${full ? 'break-all' : ''}`}
        >
          {full ? checksummed : shortAddress(checksummed)}
        </Link>
      )}
      {copy && <CopyButton text={checksummed} />}
    </span>
  );
}
