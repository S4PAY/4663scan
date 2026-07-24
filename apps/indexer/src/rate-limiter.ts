export type Lane = 'head' | 'backfill';

interface Waiter {
  count: number;
  resolve: () => void;
}

export interface LaneStats {
  /** Total tokens acquired on this lane since process start. */
  acquired: number;
  queueDepth: number;
}

export interface LimiterStats {
  head: LaneStats;
  backfill: LaneStats;
  tokens: number;
}

/**
 * Global token bucket shared by every RPC call in this process. Capacity =
 * INDEXER_MAX_RPS, refilled continuously. FIFO per lane; the head lane is
 * strictly served before backfill (backfill never sneaks tokens while a head
 * waiter is queued).
 */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly queues: Record<Lane, Waiter[]> = { head: [], backfill: [] };
  private readonly acquired: Record<Lane, number> = { head: 0, backfill: 0 };
  private lastRefill = Date.now();
  private readonly timer: NodeJS.Timeout;

  constructor(maxRps: number) {
    this.capacity = maxRps;
    this.tokens = maxRps;
    this.timer = setInterval(() => {
      this.refill();
      this.drain();
    }, 50);
  }

  acquire(count: number, lane: Lane): Promise<void> {
    this.refill();
    const queue = this.queues[lane];
    const headWaiting = this.queues.head.length > 0;
    if (queue.length === 0 && !(lane === 'backfill' && headWaiting) && this.canServe(count)) {
      this.take(count, lane);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push({ count, resolve });
    });
  }

  stats(): LimiterStats {
    return {
      head: { acquired: this.acquired.head, queueDepth: this.queues.head.length },
      backfill: {
        acquired: this.acquired.backfill,
        queueDepth: this.queues.backfill.length,
      },
      tokens: Math.max(0, Math.floor(this.tokens)),
    };
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * A request larger than the bucket is served once the bucket is full and
   * drives the level negative, so oversized batches still respect the average
   * rate instead of deadlocking.
   */
  private canServe(count: number): boolean {
    return this.tokens >= Math.min(count, this.capacity);
  }

  private take(count: number, lane: Lane): void {
    this.tokens -= count;
    this.acquired[lane] += count;
  }

  private refill(): void {
    const now = Date.now();
    const dt = now - this.lastRefill;
    if (dt <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + (dt / 1000) * this.capacity);
  }

  private drain(): void {
    const head = this.queues.head;
    while (head.length > 0 && this.canServe(head[0]!.count)) {
      const w = head.shift()!;
      this.take(w.count, 'head');
      w.resolve();
    }
    if (head.length > 0) return; // strict priority: backfill waits for head
    const backfill = this.queues.backfill;
    while (backfill.length > 0 && this.canServe(backfill[0]!.count)) {
      const w = backfill.shift()!;
      this.take(w.count, 'backfill');
      w.resolve();
    }
  }
}
