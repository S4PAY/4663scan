'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChainStatus, LiveFeed } from '@4663scan/shared/api-types';
import { formatGwei, groupThousands } from '@4663scan/shared/format';
import { NEXT_PUBLIC_API_URL } from '@/lib/config';
import { Age } from './Age';
import { AddressLink } from './AddressLink';
import { MethodChip } from './badges';
import { BlockLink, TxLink } from './links';
import { EthValue } from './values';

const BLOCK_CAP = 12;
const TX_CAP = 20;
/**
 * Feed poll cadence, matching /v1/feed's own ~2s server-side cache — a poll
 * essentially never has to wait on a fresh upstream compute. At this
 * chain's real rate (~10 blocks/s) a 2s window means the block list jumps by
 * ~20 numbers between polls rather than trickling one at a time; that's an
 * accepted tradeoff for keeping total added RPS trivial (see docs/ops.md).
 */
const FEED_POLL_MS = 2_000;
/** txsIndexed only needs to track the (slow) indexed count, not the tip. */
const STATUS_POLL_MS = 10_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API responded ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * FLIP reorder + enter animation for a keyed row list, with zero new
 * dependencies. Rows carry `data-row-key` so this can correlate DOM nodes
 * across renders without touching React's own reconciliation. A row whose
 * top moved gets an inverted transform applied instantly, then cleared next
 * frame so the stylesheet's `.feed-row` transition eases it back to rest —
 * the classic First/Last/Invert/Play technique. A row with no prior position
 * (a new arrival) gets the same treatment from a `translateY(-10px)`
 * + opacity:0 start instead, i.e. slide-down-and-fade-in. Under
 * prefers-reduced-motion this only tracks positions — it never sets a
 * transform, so rows settle instantly with no motion.
 */
function useFlipRows(containerRef: RefObject<HTMLElement | null>, keys: string[]) {
  const prevTops = useRef<Map<string, number>>(new Map());
  // Lazy useState initializer runs synchronously during the first render,
  // before any layout effect fires — unlike a ref set from a plain
  // useEffect, which only runs after layout effects and would leave the
  // very first FLIP pass (the initial 12/20 rows on mount) unable to see a
  // reduced-motion preference until one render too late.
  const [reduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  // Re-measure whenever the ordered key set changes (new/removed/reordered
  // rows) — not on every render, so hover/etc. re-renders are no-ops here.
  const keySignature = keys.join('|');

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rows: { key: string; el: HTMLElement }[] = [];
    for (const child of container.children) {
      const key = (child as HTMLElement).dataset.rowKey;
      if (key) rows.push({ key, el: child as HTMLElement });
    }

    // Container-relative, not viewport-relative: an unrelated page-level
    // shift (PriceStrip popping in above the fold once its fetch resolves,
    // an amber status banner appearing/disappearing) moves the container
    // itself, and a raw getBoundingClientRect().top would misread that as
    // every row having moved, playing a spurious animation across the whole
    // feed. Subtracting the container's own top cancels that out.
    const containerTop = container.getBoundingClientRect().top;

    const nextTops = new Map<string, number>();
    if (reduceMotion) {
      for (const { key, el } of rows) {
        nextTops.set(key, el.getBoundingClientRect().top - containerTop);
      }
      prevTops.current = nextTops;
      return;
    }

    for (const { key, el } of rows) {
      const top = el.getBoundingClientRect().top - containerTop;
      nextTops.set(key, top);
      const prevTop = prevTops.current.get(key);

      el.style.transition = 'none';
      if (prevTop != null) {
        const delta = prevTop - top;
        if (Math.abs(delta) > 0.5) {
          el.style.transform = `translateY(${delta}px)`;
          el.style.opacity = '1';
        } else {
          continue; // Unmoved row: leave it alone, nothing to animate.
        }
      } else {
        el.style.transform = 'translateY(-10px)';
        el.style.opacity = '0';
      }
      // Flush the "from" state before the "to" state so the browser has
      // something to transition between (rAF alone can coalesce with the
      // style writes above into one frame otherwise).
      void el.offsetHeight;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
      });
    }
    prevTops.current = nextTops;
    // Deliberately keyed on keySignature, not containerRef (a stable ref
    // object) or the raw keys array (a new identity every render).
  }, [keySignature, reduceMotion]);
}

export function FeedHome({
  initialStatus,
  initialFeed,
}: {
  initialStatus: ChainStatus | null;
  initialFeed: LiveFeed | null;
}) {
  const [status, setStatus] = useState<ChainStatus | null>(initialStatus);
  const [feed, setFeed] = useState<LiveFeed | null>(initialFeed);
  // Reflects the last /v1/feed poll's success, not a persistent connection
  // (there isn't one — see the polling effect below).
  const [live, setLive] = useState(initialFeed != null);

  useEffect(() => {
    let disposed = false;
    let feedTimer: ReturnType<typeof setInterval> | null = null;
    let statusTimer: ReturnType<typeof setInterval> | null = null;

    const pollFeed = async () => {
      try {
        const f = await fetchJson<LiveFeed>(`${NEXT_PUBLIC_API_URL}/v1/feed`);
        if (disposed) return;
        setFeed(f);
        setLive(true);
      } catch {
        if (!disposed) setLive(false);
      }
    };
    const pollStatus = async () => {
      try {
        const s = await fetchJson<ChainStatus>(`${NEXT_PUBLIC_API_URL}/v1/status`);
        if (!disposed) setStatus(s);
      } catch {
        // API unreachable or erroring; keep the prior value, next tick retries.
      }
    };

    // Plain polling, paused while the tab is hidden and resynced immediately
    // on return — no persistent connection to reconnect/back off, so there's
    // no unbounded-staleness window the way a torn-down SSE socket had.
    const start = () => {
      if (feedTimer != null) return;
      void pollFeed();
      void pollStatus();
      feedTimer = setInterval(() => void pollFeed(), FEED_POLL_MS);
      statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    };
    const stop = () => {
      if (feedTimer != null) clearInterval(feedTimer);
      if (statusTimer != null) clearInterval(statusTimer);
      feedTimer = null;
      statusTimer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') start();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  const blocks = feed?.blocks.slice(0, BLOCK_CAP) ?? [];
  const txs = feed?.txs.slice(0, TX_CAP) ?? [];
  const offline = !live && feed == null;

  const blocksListRef = useRef<HTMLOListElement>(null);
  const txsListRef = useRef<HTMLOListElement>(null);
  useFlipRows(
    blocksListRef,
    blocks.map((b) => `b${b.number}`),
  );
  useFlipRows(
    txsListRef,
    txs.map((t) => t.hash),
  );

  return (
    <div>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="Head block"
          value={feed ? `#${groupThousands(String(feed.headBlock))}` : '—'}
        />
        <StatTile
          label="Block time"
          value={
            feed?.blockTimeSeconds != null ? `${feed.blockTimeSeconds.toFixed(2)}s` : '—'
          }
        />
        <StatTile
          label="Base fee"
          value={
            feed?.baseFeePerGas != null ? `${formatGwei(feed.baseFeePerGas)} gwei` : '—'
          }
        />
        <StatTile
          label="Txs indexed"
          value={status ? groupThousands(String(status.txsIndexed)) : '—'}
        />
      </dl>

      {offline && (
        <div className="badge badge-amber mt-4 w-full justify-center py-2">
          API unreachable — start the API (`pnpm dev`) and this feed will connect
          automatically.
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="min-w-0">
          <header className="mb-2 flex items-center justify-between border-b border-border px-1 pb-2">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted">
              <span
                className={`live-dot ${live ? '' : 'live-dot--off'}`}
                title={live ? 'Live' : 'Disconnected'}
              />
              Latest blocks
            </h2>
            <Link href="/blocks" className="text-xs text-muted hover:text-accent">
              View all →
            </Link>
          </header>
          <ol ref={blocksListRef} className="flex flex-col gap-1.5">
            {blocks.map((b) => (
              <li
                key={b.number}
                data-row-key={`b${b.number}`}
                className="feed-row card flex min-w-0 items-center gap-3 overflow-hidden px-4 py-2.5 text-[13px] hover:bg-raised/50"
              >
                <span className="shrink-0 text-muted">⬢</span>
                <span className="min-w-0 flex-1 truncate">
                  <BlockLink number={b.number} />
                  <span className="ml-2 text-muted">
                    {b.txCount} tx{b.txCount === 1 ? '' : 's'}
                  </span>
                </span>
                <Age timestamp={b.timestamp} />
              </li>
            ))}
            {blocks.length === 0 && (
              <li className="card px-4 py-8 text-center text-sm text-muted">
                Waiting for blocks…
              </li>
            )}
          </ol>
        </section>

        <section className="min-w-0">
          <header className="mb-2 flex items-center justify-between border-b border-border px-1 pb-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">
              Latest transactions
            </h2>
            <Link href="/txs" className="text-xs text-muted hover:text-accent">
              View all →
            </Link>
          </header>
          <ol ref={txsListRef} className="flex flex-col gap-1.5">
            {txs.map((tx) => (
              <li
                key={tx.hash}
                data-row-key={tx.hash}
                className="feed-row card min-w-0 overflow-hidden px-4 py-2.5 text-[13px] hover:bg-raised/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    <TxLink hash={tx.hash} />
                    <span className="ml-2">
                      <MethodChip name={tx.methodName} id={tx.methodId} />
                    </span>
                  </span>
                  <Age timestamp={tx.timestamp} />
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden text-xs">
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                    <AddressLink address={tx.from.address} label={tx.from.label} />
                    <span className="text-muted">→</span>
                    {tx.to ? (
                      <AddressLink address={tx.to.address} label={tx.to.label} />
                    ) : tx.contractAddress ? (
                      <AddressLink address={tx.contractAddress} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </span>
                  <span className="ml-auto shrink-0">
                    <EthValue wei={tx.value} maxFrac={4} />
                  </span>
                </div>
              </li>
            ))}
            {txs.length === 0 && (
              <li className="card px-4 py-8 text-center text-sm text-muted">
                Waiting for transactions…
              </li>
            )}
          </ol>
        </section>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
