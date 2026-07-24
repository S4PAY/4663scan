'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export function SearchBar() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        ref.current?.focus();
      } else if (e.key === 'Escape' && active === ref.current) {
        ref.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      role="search"
      className="relative flex min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        const value = q.trim();
        if (value) router.push(`/search?q=${encodeURIComponent(value)}`);
      }}
    >
      <input
        ref={ref}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="tx / address / block / ticker"
        aria-label="Search"
        className="input pr-8 placeholder:font-sans"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 border border-border px-1.5 font-mono text-[11px] text-muted/80">
        /
      </kbd>
    </form>
  );
}
