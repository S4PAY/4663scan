# Architecture notes

## Storage tiering (M2)

The chain produces far more full-detail data (~50KB/block measured, ~37GB/day
at ~780k blocks/day) than a 400GB disk can retain. Storage is therefore
tiered:

- **HOT** — the last `HOT_WINDOW_SECONDS` (default 7 days) keeps full detail:
  blocks, transactions with calldata, logs, and all token transfers.
- **SLIM** — past the window, each transaction keeps a compact row (hash,
  block number, tx index, timestamp, from, to, value, method selector,
  status, contract address); its calldata, gas detail and logs are deleted.
  Blocks similarly keep number, hash, timestamp, tx count, gas used/limit and
  drop parent hash, miner, size, base fee, L1 number. Address history since
  genesis stays queryable forever.
- **NEVER PRUNED** — stock-token transfers, `tokens`, `stock_tokens`,
  `address_token_seen`, `address_labels`, `method_signatures`.

Slim-tier tx and block detail pages are hydrated on demand from RPC through
the API's cold lazy-fetch path (served ephemerally, never re-persisted into
demoted ranges).

### Physical design decisions and reasoning

**bytea for hashes/addresses/calldata.** Hex text doubles storage. A drizzle
`customType` (`hexBytea` in `packages/shared/src/db/hex-bytea.ts`) converts
0x-hex strings to `Buffer` at the driver boundary, so every app-level type,
comparison, cache key and the JSON API contract keeps lowercase hex strings.
The only places that must handle bytes explicitly are raw `ctx.sql` queries
in the API (they bind `Buffer` params via `hexToBuf`). Sort/lock-ordering
conventions are unaffected: memcmp order on bytea equals lexicographic order
on lowercase hex.

**`transactions` and `blocks` are single, unpartitioned tables; demotion is
an UPDATE that NULLs the fat columns.** The alternative — range-partitioning
with hot→slim partition swaps, or a separate slim table unioned by a view —
was considered and rejected:

- Range partitioning requires the partition key in every PK/unique index, so
  `transactions` would lose its global `hash` PK and every by-hash lookup
  would probe all partitions of an ever-growing set (slim partitions are kept
  forever, so the set grows without bound unless compacted).
- A separate slim table forces UNION-view surgery across every API list
  query, two row shapes, and writer routing.
- Update-in-place keeps *zero* read-path changes and preserves the global
  hash PK. None of the NULLed columns are indexed, so with `fillfactor = 90`
  demotion updates are HOT (heap-only) — no index churn. A partial index
  (`... WHERE input IS NOT NULL` on transactions, `WHERE parent_hash IS NOT
  NULL` on blocks) lets the retention job find not-yet-slim rows without
  scanning already-slim history, and shrinks as demotion proceeds.
- The cost — freed space is reused rather than returned, and the table's
  physical block-number clustering degrades slowly as hot inserts reuse freed
  pages — is acceptable, and the whole database is re-derivable from chain
  (genesis backfill), which keeps the option of a clean rebuild open if this
  ever needs revisiting.

**`logs` is the exception: range-partitioned by block number, pruned by
partition drops.** Logs (plus calldata) are the bulk of the 50KB/block and
have *no* forever tier — past the window they are deleted outright, so
partition drops fit perfectly: instant, no DELETE churn, no vacuum debt.
Partition width is 500k blocks (`LOGS_PARTITION_BLOCKS`, ~15h of chain);
partitions are created ahead of need by the writer (idempotent
`CREATE TABLE IF NOT EXISTS ... PARTITION OF`) and dropped by the retention
job once their entire range is past the window (`DETACH CONCURRENTLY` +
`DROP`). Partition bounds are read from the catalog, not parsed from names.
The existing `(block_number, log_index)` PK already contains the partition
key. Because backfill never writes logs for pre-hot ranges, deep history has
no logs partitions at all.

**`token_transfers` is unpartitioned; retention DELETEs non-stock rows past
the window.** On this chain most transfers are stock-token transfers, which
are never pruned — partition-dropping would require copying the (majority)
stock rows out of every partition before dropping it. Deleting the (minority)
non-stock remainder in batched block ranges is cheaper and keeps one table
with no view/UNION. The retention job tracks a `transfersPrunedThrough`
watermark in `indexer_state` so each block range is scanned once.

**FK cascades from blocks are gone.** `ON DELETE CASCADE` from
transactions/logs/token_transfers → blocks was load-bearing for reorg
rollback, but it makes any blocks-row pruning cascade into never-pruned
stock transfers, and FKs into a partitioned logs table complicate partition
drops. Reorg rollback (`head.ts rollbackTo`) and stale-fork repair
(`writer.ts`) now delete children explicitly (logs, transfers, transactions,
then blocks) in the same transaction; the ingest pipeline is the only
writer. (These reorg paths are code-reviewed but not exercised by the smoke
test — forcing a reorg against live mainnet isn't practical.)

**Tier choice is per block, by timestamp, inside the writer.** Backfill and
the API cold path pass `tier: 'auto'`; the head follower passes `'full'`
(its catch-up window is minutes, always hot). `'auto'` compares the block
timestamp against `now − HOT_WINDOW_SECONDS`: older blocks get the slim
projection (`packages/shared/src/tiering.ts`) — slim block row, slim tx rows,
no logs, transfers filtered to the stock set, but full `tokens` upserts so
historical token discovery still works. This is per block, not per source,
because backfill also fills *recent* gaps handed off by the head follower.

**Stock filtering at write/prune time uses the union of `stock_tokens` and
`tokens.is_stock_token`,** refreshed periodically. Known limitation: a token
verified as stock by the heuristic *after* backfill/retention has passed its
history will have its older transfers missing (registry tokens — the main
stocks — are seeded up front and unaffected). Recovering them would be a
targeted re-backfill; not built.

**Holdings survive pruning via `address_token_seen`.** Balances were always
live (batched Multicall3 `balanceOf`, 30s cache), but candidate *discovery*
used to probe recent `token_transfers` — once retention pruned a wallet's
last non-stock transfer, the token vanished from its holdings tab forever.
Every transfer writer (head follower, backfill, API cold persist) now also
upserts `(holder, token)` pairs into `address_token_seen` — derived from the
*unfiltered* decoded transfers, so slim blocks whose non-stock transfer rows
are skipped still register the pair; the zero address is excluded. Pairs
only, no amounts, `ON CONFLICT DO NOTHING`, sorted ascending like the tokens
upserts (cross-writer lock-order convention): the table grows with distinct
pairs, not transfer volume. Holdings discovery reads up to 200 pairs per
address — stock tokens first, so spam can never displace them from the cap,
then token-address order — and multicalls `balanceOf` in ~56-call chunks (a
gas-bomb token sinks only its own chunk); zero balances are filtered at
render, so stale pairs (orphaned forks, exited positions) cost one call slot
and nothing else. Like tx history, pairs self-heal for pre-index history as
backfill descends. RPC failure — including viem's resolve-with-all-failures
outage mode — returns `degraded: true` instead of a false empty list. Known
limitation: past 200 pairs, *non-stock* tokens sorting after the cap are
invisible in holdings; spam dusting can push a real non-stock token out
(mitigation if it ever matters: raise the cap or add curation).

**The retention job lives inside the indexer process** (new worker in
`apps/indexer/src/retention.ts`), inheriting the advisory-lock singleton,
pool, and shutdown choreography. Each pass: compute the cutoff block (newest
block older than the window, capped at `head − CONFIRM_DEPTH`), demote
transactions and blocks in `RETENTION_BATCH_BLOCKS` batches, prune non-stock
transfers up to the watermark, then drop fully-expired logs partitions.
Passes are idempotent and self-healing: tx/block re-inflation (e.g. a
cold-path persist that raced the cutoff) is found again via the partial
indexes, and the transfer prune re-scans a CONFIRM_DEPTH trailing band below
its watermark each pass — the only range such racing writes can land in.
Passes check a stop flag between batches, so shutdown never waits on a
backlog. `retention-once.ts` runs a single pass for tests/ops.

**Cold path is tier-aware in both directions.** Reads: a DB hit with
`input IS NULL` (slim tx) or `parent_hash IS NULL` (slim block) triggers an
ephemeral full-block hydrate from RPC (same `blockToRows` mapper), serving
full detail without persisting. Writes: `storeRows` applies the same
`'auto'` tier rules as backfill, so a lazily-fetched pre-hot block is
persisted slim + stock-only, never full.

### Capacity model

Measured inputs (re-measure with `docs/ops.md` queries): ~50KB/block full
detail, ~780k blocks/day. Hot tier ≈ measured-rate × window; slim tier grows
≈ (slim tx row + indexes ~300B) × tx rate + (slim block ~150B) × block rate,
forever. The hot window is an env knob (`HOT_WINDOW_SECONDS`) precisely so
the operator can trade detail depth against disk headroom without code
changes. Steady-state projection lives in the M2 deployment report; if the
chain's rate grows, shrink the window first, then consider moving slim
history to compressed storage.

## Production database

System Postgres 16 (`DATABASE_URL` is the only coupling; embedded Postgres
remains for local dev — `scripts/db.mjs` is skipped when `DB_EMBEDDED=false`).
Migrations are drizzle-kit; the partitioned `logs` DDL and storage parameters
(fillfactor, per-table autovacuum) live in a hand-written migration —
**never edit `logs` through drizzle-kit generate**.
