'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/blocks', label: 'Blocks', activePrefix: '/block' },
  { href: '/txs', label: 'Txs', activePrefix: '/tx' },
  { href: '/tokens', label: 'Tokens', activePrefix: '/token' },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-4 text-sm">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`navlink ${
            pathname.startsWith(item.activePrefix) ? 'navlink-active' : ''
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
