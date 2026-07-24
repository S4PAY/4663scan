import type { ReactNode } from 'react';

/**
 * Mobile-only replacement for a <DataTable> row: 2-3 curated lines per item
 * instead of every column stacked as its own labeled line (the old .dt
 * mobile behavior — still there, still used by tables that haven't opted
 * into this, e.g. the /tokens directory). Desktop keeps the real <table>
 * unchanged; pair with `<div className="hidden sm:block">` around it.
 */
export function MobileList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:hidden">{children}</div>;
}

export function MobileCard({ children }: { children: ReactNode }) {
  return <div className="card min-w-0 px-3 py-2 text-[13px]">{children}</div>;
}
