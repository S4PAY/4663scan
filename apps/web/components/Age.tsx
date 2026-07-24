'use client';

import { useEffect, useState } from 'react';
import { formatTimestamp, timeAgo } from '@4663scan/shared/format';

/** Live-ticking relative time; ticks every second only while < 1h old. */
export function Age({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (Date.now() / 1000 - timestamp >= 3600) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timestamp]);

  return (
    <time
      suppressHydrationWarning
      title={formatTimestamp(timestamp)}
      dateTime={new Date(timestamp * 1000).toISOString()}
      className="whitespace-nowrap tabular-nums text-muted"
    >
      {timeAgo(timestamp, now)}
    </time>
  );
}
