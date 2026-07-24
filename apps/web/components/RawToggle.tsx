'use client';

import { isHexString } from '@4663scan/shared/format';

/** Collapsible raw hex viewer for tx input / log data. */
export function RawToggle({
  label = 'Raw data',
  data,
  defaultOpen = false,
}: {
  label?: string;
  data: string;
  defaultOpen?: boolean;
}) {
  const bytes = isHexString(data) ? (data.length - 2) / 2 : null;
  return (
    <details className="group min-w-0" open={defaultOpen}>
      <summary className="cursor-pointer select-none text-[13px] text-muted transition-colors hover:text-accent">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
        {bytes != null && <span className="ml-1.5 text-xs">({bytes} bytes)</span>}
      </summary>
      <pre className="raw mt-1.5">{data}</pre>
    </details>
  );
}
