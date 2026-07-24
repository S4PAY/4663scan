import Link from 'next/link';
import { groupThousands, shortHash } from '@4663scan/shared/format';
import type { ReactNode } from 'react';

export function TxLink({ hash, full = false }: { hash: string; full?: boolean }) {
  return (
    <Link
      href={`/tx/${hash.toLowerCase()}`}
      className={`hashlink ${full ? 'break-all' : ''}`}
      title={hash}
    >
      {full ? hash : shortHash(hash)}
    </Link>
  );
}

export function BlockLink({ number, grouped = false }: { number: number; grouped?: boolean }) {
  return (
    <Link href={`/block/${number}`} className="hashlink">
      {grouped ? groupThousands(String(number)) : number}
    </Link>
  );
}

export function TokenLink({
  address,
  children,
}: {
  address: string;
  children?: ReactNode;
}) {
  return (
    <Link href={`/token/${address.toLowerCase()}`} className="hashlink" title={address}>
      {children ?? shortHash(address, 6, 4)}
    </Link>
  );
}
