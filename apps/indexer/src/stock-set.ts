import type { Logger } from 'pino';
import type { Db } from '@4663scan/shared/db';
import { loadStockAddressSet } from '@4663scan/shared/tiering';
import { sleep } from './util.js';

/** Stock discovery is eventually consistent; pick up new flags within minutes. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Process-wide cache of the never-pruned token address set (stock_tokens ∪
 * tokens.is_stock_token), consumed by the slim write path and retention.
 * Refreshed periodically because heuristic discoveries land after first
 * sight; a failed refresh keeps the previous set rather than shrinking it.
 */
export class StockSetProvider {
  private set = new Set<string>();
  private running = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  get(): ReadonlySet<string> {
    return this.set;
  }

  /** Resolves after the initial load so dependents never see an empty set. */
  async start(): Promise<void> {
    this.running = true;
    await this.refresh();
    this.logger.info({ size: this.set.size }, 'stock address set loaded');
    this.timer = setInterval(() => void this.refreshOnce(), REFRESH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await sleep(50);
  }

  async refresh(): Promise<void> {
    this.set = await loadStockAddressSet(this.db);
  }

  private async refreshOnce(): Promise<void> {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      await this.refresh();
    } catch (err) {
      this.logger.warn({ err }, 'stock set refresh failed; keeping previous set');
    } finally {
      this.busy = false;
    }
  }
}
