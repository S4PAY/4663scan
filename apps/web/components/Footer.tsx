import Link from 'next/link';
import type { ChainStatus } from '@4663scan/shared/api-types';
import { groupThousands } from '@4663scan/shared/format';
import { apiGet } from '@/lib/api';
import { backfillPercent } from '@/lib/backfill';
import { AddToWalletButton } from './AddToWalletButton';

export async function Footer() {
  let status: ChainStatus | null = null;
  try {
    status = await apiGet<ChainStatus>('/status', { revalidate: 2 });
  } catch {
    // API down: footer shows offline state, pages handle their own errors.
  }
  const pct = status ? backfillPercent(status) : null;

  return (
    <footer className="mt-10 border-t border-border">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-[minmax(0,1.1fr)_auto_auto_auto]">
          <div className="min-w-0 max-w-xs">
            <Link
              href="/"
              className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-tight"
            >
              {/* alt="" — see layout.tsx header for the same treatment. */}
              <img src="/mark-header.png" alt="" className="h-5 w-auto shrink-0" />
              <span className="text-accent">4663</span>
              <span>scan</span>
            </Link>
            <p className="mt-1.5 text-xs text-muted">
              Block explorer for Robinhood Chain — blocks, transactions, tokens
              and tokenized stocks, live from mainnet.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <a
                href="https://github.com/S4PAY/4663scan"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="4663scan on GitHub"
                className="navlink"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current">
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
              </a>
              <a
                href="https://x.com/4663scan"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="4663scan on X"
                className="navlink"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Explore
            </div>
            <nav className="mt-2 flex flex-col gap-1.5 text-sm">
              <Link href="/blocks" className="navlink">
                Blocks
              </Link>
              <Link href="/txs" className="navlink">
                Txs
              </Link>
              <Link href="/tokens" className="navlink">
                Tokens
              </Link>
            </nav>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Products &amp; services
            </div>
            <nav className="mt-2 flex flex-col gap-1.5 text-sm">
              <Link href="/docs" className="navlink">
                API docs
              </Link>
              <Link href="/submit-token" className="navlink">
                Submit a token
              </Link>
              <Link href="/advertise" className="navlink">
                Advertise
              </Link>
              <AddToWalletButton />
            </nav>
          </div>

          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Status
            </div>
            <div className="mt-2 flex flex-col gap-1 text-xs text-muted">
              <span className="mono">chain id {status?.chainId ?? 4663}</span>
              {status ? (
                <>
                  {/*
                    Quiet, historical framing only — no live-tip comparison.
                    This chain's indexed range can trail real time by a very
                    large, growing margin on free RPC (docs/ops.md); the home
                    feed reads the tip straight from RPC instead, so the
                    footer's job is just to say how far history has been
                    indexed, not to imply the two should match.
                  */}
                  <span>
                    history indexed to #{groupThousands(String(status.indexedBlock))}
                  </span>
                  {status.backfill.enabled && !status.backfill.done && (
                    <span>backfill {pct != null ? `${pct}%` : '…'} to genesis</span>
                  )}
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-red" />
                  API offline
                </span>
              )}
            </div>
          </div>
        </div>

        <p className="mt-6 border-t border-border/60 pt-4 text-[11px] text-muted/80">
          Independent explorer for Robinhood Chain — not affiliated with,
          endorsed by, or sponsored by Robinhood Markets, Inc.
        </p>
      </div>
    </footer>
  );
}
