import { eq, gt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { makeWsClient } from '@4663scan/shared/chain';
import { blocks, logs, tokenTransfers, transactions, type Db } from '@4663scan/shared/db';
import type { LogsPartitionManager } from '@4663scan/shared/db/partitions';
import { env } from '@4663scan/shared/env';
import { BlockUnavailableError, type BlockBundle, type RpcClient } from './rpc.js';
import {
  initStateIfAbsent,
  readBackfillState,
  readHeadState,
  writeState,
} from './state.js';
import { ingestBlocks } from './writer.js';
import { hexToNum, range, sleep } from './util.js';

const HEAD_CHUNK = 16;
/** Startup gaps larger than this are handed to the backfill instead. */
const CATCHUP_GAP_LIMIT = 5000;
const POLL_INTERVAL_MS = 300;
/** Poll kicks back in when the WSS subscription has been silent this long. */
const WSS_STALE_MS = 15_000;
/**
 * Resubscribe backoff: doubles each consecutive failure (no confirmed
 * newHeads event since the last attempt), capped, reset the moment a real
 * event arrives. A fixed retry-forever delay here is indistinguishable from
 * a denial-of-service attempt to whatever's rate-limiting the reconnects —
 * this incident's WSS 429s never had a chance to clear under one.
 */
const RESUBSCRIBE_BASE_DELAY_MS = 3000;
const RESUBSCRIBE_MAX_DELAY_MS = 60_000;
/**
 * How long the head pointer (poll-observed latest, or the fetch cursor) may
 * go without genuine progress before it's treated as "the primary node is
 * stuck, not just between blocks" and this chain's real ~100ms block time
 * makes that an enormous, unambiguous margin. Below this, transient jitter
 * (batching, network latency) is expected and not a symptom of anything.
 */
const PRIMARY_STALE_MS = 5_000;
/**
 * Backoff when a fallback-pool endpoint itself errors while in use (its own
 * quota, separate from this process's RateLimiter, and separate per
 * endpoint — see pickFallback). Same philosophy as the WSS resubscribe
 * backoff: retrying a rate-limited endpoint immediately just prolongs the
 * lockout instead of giving its quota room to recover. Triggers on ANY
 * error from a fallback-routed call, not just ones that duck-type as a
 * clean 429 — confirmed live that these endpoints sometimes return a
 * malformed (non-array) response instead of a proper batched 429 when
 * already near their limit, which surfaces as a generic parse error, not a
 * recognizable rate-limit shape.
 */
const FALLBACK_COOLDOWN_BASE_MS = 5_000;
const FALLBACK_COOLDOWN_MAX_MS = 60_000;

/** Duck-types viem's RpcRequestError shape for a 429 — used only to log
 *  which failure mode was hit, not to gate whether to back off. */
function isRateLimitError(err: unknown): boolean {
  const code = (err as { code?: unknown; status?: unknown } | null)?.code;
  if (code === 429) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /too many requests|rate limit/i.test(message);
}

export class HeadFollower {
  private lastBlock = 0;
  private lastHash = '';
  private targetHead = 0;
  private running = false;
  private processing = false;
  private polling = false;
  private wssHealthy = false;
  private lastWssEventAt = 0;
  private unwatch: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private resubTimer: NodeJS.Timeout | null = null;
  /** Rebuilt on resubscribe; see closeWsSocket for why. */
  private wsClient = makeWsClient(env);
  /** Consecutive resubscribe attempts since the last confirmed newHeads event. */
  private wssFailureStreak = 0;

  /**
   * When `lastBlock` (real, committed progress) last advanced. The single
   * source of truth for "is the primary stuck" — used by both pollOnce and
   * process(). An earlier version tracked the shared client's raw
   * eth_blockNumber answer separately, on the theory that a "confirmed
   * recovery" needed its own signal distinct from whatever the fallback
   * probe returned — that shared client (`this.rpc`, the primary-preferring
   * fallback() transport) turned out to alternate between the stuck
   * primary's answer and a fresh one on nearly every call (confirmed live:
   * consecutive calls a couple seconds apart returning first a fresh block,
   * then the frozen one, repeatedly) — noise, not a recovery signal, and it
   * made the tracking thrash. Real committed progress doesn't have that
   * problem: it only changes when a fetch has actually succeeded.
   */
  private lastBlockAdvancedAt = Date.now();
  /** Round-robin cursor into fallbackPool; see pickFallback. */
  private fallbackRotationIndex = 0;
  /** Per-endpoint backoff state, indexed the same as fallbackPool. */
  private readonly fallbackCooldownUntil: number[];
  private readonly fallbackFailureStreak: number[];

  constructor(
    private readonly db: Db,
    private readonly rpc: RpcClient,
    /**
     * One entry per configured fallback endpoint (RPC_HTTP_FALLBACK,
     * _TERTIARY, _QUATERNARY — whichever main.ts found set), each pinned via
     * makeDirectHttpClient. Rotated round-robin when the primary is stale
     * (see pickFallback) so no single free-tier provider's own rate limit
     * caps recovery throughput the way relying on just one did — confirmed
     * live that a lone fallback tops out around 1.5-2 blocks/s regardless of
     * batching/pacing tuning, well below this chain's real ~10 blocks/s.
     * Every entry shares the caller's RateLimiter — this never adds RPS
     * budget, only spreads some of it across more upstream destinations.
     */
    private readonly fallbackPool: { rpc: RpcClient; url: string }[],
    private readonly partitions: LogsPartitionManager,
    private readonly logger: Logger,
  ) {
    this.fallbackCooldownUntil = new Array(fallbackPool.length).fill(0) as number[];
    this.fallbackFailureStreak = new Array(fallbackPool.length).fill(0) as number[];
  }

  get lastIngested(): number {
    return this.lastBlock;
  }

  get target(): number {
    return this.targetHead;
  }

  get wssOk(): boolean {
    return this.wssHealthy;
  }

  async start(): Promise<void> {
    this.running = true;
    const state = await readHeadState(this.db);
    const latest = await this.rpc.getLatestBlockNumber('head');

    if (state == null) {
      this.logger.info({ latest }, 'fresh database: starting head-first at latest block');
      const bundle = await this.fetchOneWithRetry(latest);
      const hash = bundle.block.hash.toLowerCase();
      // First ingest, head checkpoint and backfill init commit atomically:
      // a crash between separate writes would leave a head checkpoint with
      // no backfill row, idling the backfill forever.
      await ingestBlocks(this.db, [bundle], {
        notify: true,
        tierMode: 'full',
        partitions: this.partitions,
        state: [
          { key: 'head', value: { lastBlock: latest, lastHash: hash } },
          {
            key: 'backfill',
            value: { cursor: latest - 1, floor: 0, startedFrom: latest, gaps: [] },
          },
        ],
      });
      this.lastBlock = latest;
      this.lastHash = hash;
    } else {
      this.lastBlock = state.lastBlock;
      this.lastHash = state.lastHash;
      const gap = latest - state.lastBlock;
      this.logger.info(
        { lastBlock: state.lastBlock, latest, gap },
        'resuming from checkpoint',
      );
      // Heal databases initialized before the atomic fresh-DB init above:
      // a head checkpoint without a backfill row would idle the backfill.
      await initStateIfAbsent(this.db, {
        key: 'backfill',
        value: {
          cursor: state.lastBlock - 1,
          floor: 0,
          startedFrom: state.lastBlock,
          gaps: [],
        },
      });
      if (gap > CATCHUP_GAP_LIMIT) {
        // Too far behind to catch up inline without stalling the live feed:
        // hand the range to the backfill and jump straight to the head. The
        // pushed gap commits in the same transaction as the jump block and
        // head checkpoint, so a crash cannot record the gap twice.
        const backfill = (await readBackfillState(this.db)) ?? {
          cursor: state.lastBlock - 1,
          floor: 0,
          startedFrom: state.lastBlock,
          gaps: [],
        };
        backfill.gaps.push({ lo: state.lastBlock + 1, hi: latest - 1 });
        this.logger.warn(
          { lo: state.lastBlock + 1, hi: latest - 1 },
          'large gap handed to backfill; jumping to live head',
        );
        const bundle = await this.fetchOneWithRetry(latest);
        const hash = bundle.block.hash.toLowerCase();
        await ingestBlocks(this.db, [bundle], {
          notify: true,
          tierMode: 'full',
          partitions: this.partitions,
          state: [
            { key: 'head', value: { lastBlock: latest, lastHash: hash } },
            { key: 'backfill', value: backfill },
          ],
        });
        this.lastBlock = latest;
        this.lastHash = hash;
      }
    }

    this.targetHead = Math.max(this.lastBlock, latest);
    this.subscribe();
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
    void this.process();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.unwatch?.();
    this.unwatch = null;
    await this.closeWsSocket();
    while (this.processing || this.polling) await sleep(50);
  }

  private onNewHead(n: number): void {
    if (n > this.targetHead) this.targetHead = n;
    void this.process();
  }

  /**
   * Round-robins across the fallback pool, skipping any endpoint presently
   * cooling down from its own error backoff. Spreading load this way is
   * what lets aggregate recovery throughput exceed what any single free-tier
   * provider tolerates alone — each takes a turn instead of one absorbing
   * every request. Returns null only when every configured fallback is
   * currently cooling down (a genuine "nothing left to try but the primary"
   * state, at which point process()/pollOnce() fall through to it).
   */
  private pickFallback(): { rpc: RpcClient; url: string; index: number } | null {
    const n = this.fallbackPool.length;
    if (n === 0) return null;
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      const index = (this.fallbackRotationIndex + i) % n;
      if (now >= this.fallbackCooldownUntil[index]!) {
        this.fallbackRotationIndex = (index + 1) % n;
        const entry = this.fallbackPool[index]!;
        return { rpc: entry.rpc, url: entry.url, index };
      }
    }
    return null;
  }

  /**
   * Every fallback-pool entry not presently cooling down, in rotation order.
   * Used by process() to fetch several HEAD_CHUNK-sized sub-ranges
   * CONCURRENTLY (one per available provider) instead of one chunk per
   * provider per turn — round-robin alone (pickFallback, still used by
   * pollOnce's lightweight probe) only ever has one fetch in flight, so it
   * reduces how often any single provider's own limit trips but can't make
   * aggregate throughput exceed what one provider tolerates alone. This is
   * what actually lets recovery throughput approach the chain's real rate
   * when the primary is down and multiple fallbacks are healthy.
   */
  private pickFallbackGroup(): { rpc: RpcClient; url: string; index: number }[] {
    const n = this.fallbackPool.length;
    if (n === 0) return [];
    const now = Date.now();
    const picked: { rpc: RpcClient; url: string; index: number }[] = [];
    for (let i = 0; i < n; i++) {
      const index = (this.fallbackRotationIndex + i) % n;
      if (now >= this.fallbackCooldownUntil[index]!) {
        const entry = this.fallbackPool[index]!;
        picked.push({ rpc: entry.rpc, url: entry.url, index });
      }
    }
    if (picked.length > 0) this.fallbackRotationIndex = (this.fallbackRotationIndex + 1) % n;
    return picked;
  }

  /** Records a successful fallback-pool call — clears its backoff streak. */
  private noteFallbackSuccess(index: number): void {
    this.fallbackFailureStreak[index] = 0;
  }

  /** Records a failed fallback-pool call — backs off that endpoint specifically. */
  private noteFallbackFailure(index: number, url: string, err: unknown): void {
    const streak = (this.fallbackFailureStreak[index] ?? 0) + 1;
    this.fallbackFailureStreak[index] = streak;
    const backoff = Math.min(FALLBACK_COOLDOWN_MAX_MS, FALLBACK_COOLDOWN_BASE_MS * 2 ** (streak - 1));
    this.fallbackCooldownUntil[index] = Date.now() + backoff;
    this.logger.warn(
      { url, backoffMs: backoff, rateLimited: isRateLimitError(err) },
      'fallback pool endpoint errored; backing off from it',
    );
  }

  /**
   * Fetches up to `maxSpan` blocks starting at `from` by splitting into
   * ≤HEAD_CHUNK-sized sub-ranges, one per currently-available fallback
   * provider, fetched CONCURRENTLY — then returns the combined, correctly-
   * ordered bundle list. The commit side (verifyChain/ingestBlocks) is
   * completely unaffected: it still receives one ordered array and still
   * writes one checkpoint, exactly as with a single-provider chunk: only
   * the FETCH phase is parallelized, not the ordering or commit guarantees.
   *
   * Sub-ranges are contiguous and ordered (the first covers [from, ...),
   * the second picks up where it left off, etc.), so a failure partway
   * through only voids the ranges from that point on — anything fetched
   * for an earlier sub-range is still a valid, gap-free prefix starting at
   * `from` and is returned as-is; the caller advances lastBlock by however
   * much came back. A later sub-range that happened to succeed AFTER an
   * earlier failure can't be used (keeping it would leave the earlier gap
   * unfilled) so its data is dropped, but every sub-range's success/failure
   * is still recorded via noteFallbackSuccess/noteFallbackFailure regardless
   * of position, so per-endpoint backoff state stays accurate. Returns null
   * only when even the first sub-range failed (no usable prefix at all), at
   * which point the caller falls back to trying the primary for one plain
   * chunk instead.
   */
  private async fetchFallbackGroup(from: number, maxSpan: number): Promise<BlockBundle[] | null> {
    const group = this.pickFallbackGroup();
    if (group.length === 0) return null;
    const to = from + maxSpan - 1;
    const subRanges: { nums: number[]; provider: (typeof group)[number] }[] = [];
    let cursor = from;
    for (const provider of group) {
      if (cursor > to) break;
      const subTo = Math.min(to, cursor + HEAD_CHUNK - 1);
      subRanges.push({ nums: range(cursor, subTo), provider });
      cursor = subTo + 1;
    }
    const results = await Promise.allSettled(
      subRanges.map((r) => r.provider.rpc.getBlocksWithReceipts(r.nums, 'head')),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const { provider } = subRanges[i]!;
      if (result.status === 'fulfilled') this.noteFallbackSuccess(provider.index);
      else this.noteFallbackFailure(provider.index, provider.url, result.reason);
    }
    const combined: BlockBundle[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') break;
      combined.push(...result.value);
    }
    return combined.length > 0 ? combined : null;
  }

  /**
   * Single-flight ingest loop: fetch (last, target] ascending. Normally in
   * ≤HEAD_CHUNK chunks via the primary-preferring shared client; when the
   * primary is stale, fetches ≤HEAD_CHUNK-per-provider sub-ranges from every
   * currently-available fallback CONCURRENTLY (fetchFallbackGroup) so
   * aggregate recovery throughput isn't capped by any single provider's own
   * rate limit. Either way, verifyChain/ingestBlocks below still receive one
   * ordered bundle array and write one checkpoint — only the fetch phase
   * changes shape, never the commit ordering.
   */
  private async process(): Promise<void> {
    if (this.processing || !this.running) return;
    this.processing = true;
    try {
      while (this.running && this.lastBlock < this.targetHead) {
        // A stuck-but-answering primary (e.g. returning null for a block
        // range it hasn't actually caught up to) never throws from viem's
        // point of view, so it never triggers the fallback() wrapper's own
        // failover — only genuine elapsed time without progress reveals it.
        // lastBlock is real, committed progress (unlike targetHead, which a
        // stuck primary can still nudge via pollOnce below).
        const primaryStale = Date.now() - this.lastBlockAdvancedAt > PRIMARY_STALE_MS;
        let usedFallback = false;
        try {
          const from = this.lastBlock + 1;
          let bundles: BlockBundle[];
          if (primaryStale) {
            const span = Math.min(
              this.targetHead - this.lastBlock,
              HEAD_CHUNK * Math.max(1, this.fallbackPool.length),
            );
            const group = await this.fetchFallbackGroup(from, span);
            if (group != null) {
              bundles = group;
              usedFallback = true;
            } else {
              // Every fallback is cooling down, or the group attempt just
              // failed (already backed off per-endpoint inside
              // fetchFallbackGroup) — retry the primary meanwhile, on the
              // chance it's recovered, rather than doing nothing this pass.
              const to = Math.min(this.targetHead, this.lastBlock + HEAD_CHUNK);
              bundles = await this.rpc.getBlocksWithReceipts(range(from, to), 'head');
            }
          } else {
            const to = Math.min(this.targetHead, this.lastBlock + HEAD_CHUNK);
            bundles = await this.rpc.getBlocksWithReceipts(range(from, to), 'head');
          }
          if (!(await this.verifyChain(bundles))) continue; // reorg handled; refetch
          const last = bundles[bundles.length - 1]!;
          const lastNumber = hexToNum(last.block.number);
          const lastHash = last.block.hash.toLowerCase();
          const res = await ingestBlocks(this.db, bundles, {
            notify: true,
            tierMode: 'full',
            partitions: this.partitions,
            state: { key: 'head', value: { lastBlock: lastNumber, lastHash } },
          });
          if (usedFallback) {
            this.logger.debug({ from, count: bundles.length }, 'fetched via fallback pool');
          }
          this.lastBlock = lastNumber;
          this.lastHash = lastHash;
          this.lastBlockAdvancedAt = Date.now();
          this.logger.debug(
            { from, to: lastNumber, txs: res.txCount, transfers: res.transferCount },
            'head ingested',
          );
        } catch (err) {
          if (!this.running) break;
          if (err instanceof BlockUnavailableError) {
            // Head announced via WSS but the HTTP node hasn't caught up yet
            // (or the primary-retry fallthrough above hit the same thing).
            await sleep(200);
          } else {
            // fetchFallbackGroup already applies per-endpoint backoff
            // internally on partial/full failure (see noteFallbackFailure);
            // an error surfacing here is either from the primary-retry
            // fallthrough or some other unexpected failure — a flat pause
            // is the right response either way.
            this.logger.warn({ err }, 'head ingest failed; retrying');
            await sleep(1000);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Reorg check on every appended block: parentHash must match the stored
   * hash of number−1 (in-memory checkpoint, DB, or intra-batch). A missing
   * DB parent (below a jump boundary) skips the check.
   */
  private async verifyChain(bundles: BlockBundle[]): Promise<boolean> {
    const first = bundles[0];
    if (first == null) return true;
    const firstNumber = hexToNum(first.block.number);
    let expected: string | null;
    if (firstNumber - 1 === this.lastBlock && this.lastHash !== '') {
      expected = this.lastHash;
    } else {
      expected = await this.dbHash(firstNumber - 1);
    }
    for (const bundle of bundles) {
      const parent = bundle.block.parentHash.toLowerCase();
      if (expected != null && parent !== expected) {
        await this.recoverReorg(hexToNum(bundle.block.number));
        return false;
      }
      expected = bundle.block.hash.toLowerCase();
    }
    return true;
  }

  private async recoverReorg(mismatchAt: number): Promise<void> {
    this.logger.warn(
      { block: mismatchAt },
      'REORG detected: parent hash mismatch, walking back to find fork point',
    );
    // Nothing above the in-memory checkpoint has been ingested yet, so the
    // fork point can only be at or below it. A mismatch inside a fetched
    // batch (the tip reorged mid-fetch, or transports served two nodes)
    // therefore walks from the checkpoint: typically a same-hash match right
    // there, i.e. a no-op rollback, and the batch is simply refetched.
    // Starting any higher would misread never-ingested batch blocks
    // (stored == null) as a jump boundary and advance the checkpoint past
    // blocks that were never written — a permanent, gap-less hole.
    const start = Math.min(mismatchAt - 1, this.lastBlock);
    const floor = Math.max(0, start - env.REORG_LIMIT);
    for (let n = start; n >= floor; n--) {
      const stored = await this.dbHash(n);
      if (stored == null) {
        // n is at or below the checkpoint with no stored row: below the
        // contiguously indexed range (jump boundary). Everything above n is
        // suspect; restart from the canonical RPC hash of n.
        const rpcHash = await this.rpc.getBlockHash(n, 'head');
        if (rpcHash != null) {
          await this.rollbackTo(n, rpcHash);
          return;
        }
        continue;
      }
      const rpcHash = await this.rpc.getBlockHash(n, 'head');
      if (rpcHash != null && rpcHash === stored) {
        await this.rollbackTo(n, stored);
        return;
      }
    }
    this.logger.error(
      { mismatchAt, reorgLimit: env.REORG_LIMIT },
      'no fork point within REORG_LIMIT; refusing to continue — operator intervention required',
    );
    // Give the pino transport worker a beat to flush the line above before
    // dying (mirrors the shutdown path in main.ts).
    await sleep(100);
    process.exit(1);
  }

  private async rollbackTo(forkPoint: number, hash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // No FKs from children to blocks: children are deleted explicitly,
      // in the same transaction as the block rows and the checkpoint.
      await tx.delete(logs).where(gt(logs.blockNumber, forkPoint));
      await tx.delete(tokenTransfers).where(gt(tokenTransfers.blockNumber, forkPoint));
      await tx.delete(transactions).where(gt(transactions.blockNumber, forkPoint));
      await tx.delete(blocks).where(gt(blocks.number, forkPoint));
      await writeState(tx, {
        key: 'head',
        value: { lastBlock: forkPoint, lastHash: hash },
      });
    });
    this.lastBlock = forkPoint;
    this.lastHash = hash;
    this.lastBlockAdvancedAt = Date.now();
    this.logger.warn({ forkPoint }, 'REORG: rolled back; re-ingesting forward');
  }

  private async dbHash(n: number): Promise<string | null> {
    const rows = await this.db
      .select({ hash: blocks.hash })
      .from(blocks)
      .where(eq(blocks.number, n));
    return rows[0]?.hash ?? null;
  }

  /**
   * Polling is the resilient default; WSS is purely a latency optimization
   * on top of it. So this deliberately does NOT mark wssHealthy=true just
   * because watchBlockNumber() was called without throwing synchronously —
   * that only means the attempt started, not that the socket is open. Until
   * onBlockNumber actually fires (emitOnBegin:true makes that near-instant
   * on a genuinely working connection), pollOnce's `wssHealthy` gate below
   * stays false and polling keeps covering for it fully, exactly as it
   * should during a bad WSS patch — see this incident, where the previous
   * optimistic flag briefly masked poll ticks around every resubscribe.
   */
  private subscribe(): void {
    if (this.wsClient == null) {
      this.logger.info('RPC_WSS not set; head follows via 300ms polling only');
      return;
    }
    try {
      this.unwatch = this.wsClient.watchBlockNumber({
        emitOnBegin: true,
        onBlockNumber: (bn) => {
          this.wssFailureStreak = 0;
          this.wssHealthy = true;
          this.lastWssEventAt = Date.now();
          this.onNewHead(Number(bn));
        },
        onError: (err) => {
          if (this.wssHealthy) {
            this.logger.warn({ err: err.message }, 'wss error; polling until resubscribed');
          }
          this.wssHealthy = false;
          this.wssFailureStreak += 1;
          this.scheduleResubscribe();
        },
      });
      this.logger.info({ wss: env.RPC_WSS }, 'subscribing to new heads via wss');
    } catch (err) {
      this.logger.warn({ err }, 'wss subscribe failed; polling until resubscribed');
      this.wssHealthy = false;
      this.wssFailureStreak += 1;
      this.scheduleResubscribe();
    }
  }

  /**
   * Exponential, capped: 3s, 6s, 12s, 24s, 48s, 60s, 60s, ... A fixed delay
   * that never backs off is indistinguishable, from the far end, from a
   * client that won't stop hammering a reconnect — precisely what appears
   * to have kept this incident's WSS 429 from ever clearing. Resets to the
   * base delay the moment onBlockNumber confirms a real connection again.
   */
  private scheduleResubscribe(): void {
    if (!this.running || this.resubTimer != null) return;
    const delay = Math.min(
      RESUBSCRIBE_MAX_DELAY_MS,
      RESUBSCRIBE_BASE_DELAY_MS * 2 ** Math.max(0, this.wssFailureStreak - 1),
    );
    this.resubTimer = setTimeout(() => {
      this.resubTimer = null;
      if (!this.running) return;
      void this.resubscribe();
    }, delay);
  }

  private async resubscribe(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    await this.closeWsSocket();
    // stop() may have completed while the close was in flight.
    if (!this.running) return;
    // Fresh client on top of the now-evicted socket cache.
    this.wsClient = makeWsClient(env);
    this.subscribe();
  }

  /**
   * Closes the underlying WS socket client. viem caches socket clients
   * module-wide per URL, and a client whose 5 reconnect attempts are
   * exhausted stays dead in that cache forever — only close() evicts it, and
   * a freshly built PublicClient would still be handed the dead socket.
   */
  private async closeWsSocket(): Promise<void> {
    const transport = this.wsClient?.transport as unknown as
      | { getRpcClient?: () => Promise<{ close(): void }> }
      | undefined;
    if (transport?.getRpcClient == null) return;
    // A cached client resolves immediately; when nothing is cached this
    // starts a fresh connect that may hang or reject, so observe the
    // rejection eagerly (a late loser of the race must not become an
    // unhandled rejection) and bound the wait — close() is then a no-op.
    const client = await Promise.race([
      transport.getRpcClient().catch(() => null),
      sleep(1000).then(() => null),
    ]);
    try {
      client?.close();
    } catch {
      // Socket already torn down; nothing to close.
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) return;
    const wssSilentMs = Date.now() - this.lastWssEventAt;
    if (this.wssHealthy && wssSilentMs < WSS_STALE_MS) return;
    this.polling = true;
    try {
      let latest = await this.rpc.getLatestBlockNumber('head');
      // Same staleness signal process() uses (real committed progress),
      // not this call's own answer — the shared client alternates between
      // the stuck primary and a fresh response often enough per-call that
      // it's not a usable signal on its own (see the field comment above).
      const stale = Date.now() - this.lastBlockAdvancedAt > PRIMARY_STALE_MS;
      if (stale) {
        const picked = this.pickFallback();
        if (picked) {
          try {
            const direct = await picked.rpc.getLatestBlockNumber('head');
            if (direct > latest) latest = direct;
            this.noteFallbackSuccess(picked.index);
          } catch (err) {
            // Any error here (not just a recognizable 429 shape — see the
            // matching comment in process()'s catch block) means this
            // fallback's probe failed too; back it off specifically rather
            // than retrying it every 300ms tick.
            this.noteFallbackFailure(picked.index, picked.url, err);
          }
        }
      }
      if (this.wssHealthy && latest > this.targetHead) {
        // The subscription claims healthy but the chain advanced without a
        // newHeads event for WSS_STALE_MS: silent drop (half-open socket).
        // onError never fires in that case, so resubscribe from here.
        this.logger.warn(
          { wssSilentMs },
          'wss silent while chain advanced; resubscribing',
        );
        this.wssHealthy = false;
        this.scheduleResubscribe();
      }
      this.onNewHead(latest);
    } catch {
      // transient RPC failure; next tick retries
    } finally {
      this.polling = false;
    }
  }

  private async fetchOneWithRetry(n: number): Promise<BlockBundle> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpc.getBlockWithReceipts(n, 'head');
      } catch (err) {
        if (attempt >= 20) throw err;
        await sleep(err instanceof BlockUnavailableError ? 250 : 1000);
      }
    }
  }
}
