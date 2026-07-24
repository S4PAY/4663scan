# Operations runbook

Production runs the three apps under PM2 behind Caddy, against system
Postgres 16. All knobs live in the repo-root `.env` (never committed).
Nothing in this repo may contain server IPs or infrastructure identifiers.

## Processes

```sh
pm2 status                 # indexer / api / web
pm2 logs indexer --lines 100
pm2 restart api            # apps re-read .env on restart
pm2 save                   # persist process list after changes
```

The indexer logs a stats line every 10s (head lag, backfill cursor, rps) and
the retention worker logs one line per pass:
`{cutoffBlock, txsDemoted, blocksDemoted, transfersDeleted, partitionsDropped}`.

### Detecting a head stall (RPC provider trouble)

`head` and `lag` in the stats line (and `indexedBlock`/`headBlock` in
`GET /v1/status`) should track each other closely and `indexedBlock` should
advance every poll — this chain produces a block roughly every 100ms. A
frozen `indexedBlock` across two `/v1/status` calls a few seconds apart, or
repeated `"wss error"` / `"wss silent while chain advanced"` lines in
`pm2 logs indexer`, means the RPC provider is in trouble, not the indexer
itself. Root-caused once (2026-07): `wss://ws.arrowrpc.com` got rate-limited
(HTTP 429) by its Cloudflare edge, and independently `RPC_HTTP_PRIMARY`'s
`eth_blockNumber` got stuck serving one frozen block number — both look like
normal 200-OK/valid-handshake traffic, so the indexer's own retry/failover
logic can't always tell on its own; confirm directly:

```sh
curl -s -X POST "$RPC_HTTP_PRIMARY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# run twice, a few seconds apart — identical results with real chain
# activity elsewhere means the PRIMARY is stuck, not the network/indexer.
```

The head-follower (`apps/indexer/src/head.ts`) is designed to self-heal from
this without a restart: a watchdog treats "no progress in 5s" as the primary
being stuck and reroutes through a pool of clients pinned directly to
whichever of `RPC_HTTP_FALLBACK`, `RPC_HTTP_TERTIARY`, `RPC_HTTP_QUATERNARY`,
`RPC_HTTP_QUINARY` are set in `.env` (bypassing the primary-preferring client,
which won't fail over on a stuck-but-answering response on its own). Every currently-available
pool endpoint is fetched from CONCURRENTLY (not round-robin one-at-a-time) so
aggregate recovery throughput isn't capped by any single free-tier provider's
own rate limit — added 2026-07-22 after a single fallback alone was measured
capping recovery around 1.5-2 blocks/s. The WSS resubscribe loop separately
backs off exponentially (3s → 60s cap) instead of hammering a rate-limited
endpoint forever. Look for `"fetched via fallback pool"` in the logs — that's
the self-heal working, and `indexedBlock` should keep climbing (often in
bursts, not smoothly, since each pool endpoint has its own separate rate
limit — `"fallback pool endpoint errored; backing off from it"` means that
specific endpoint tripped its own limit and is cooling down while the others
keep going, which is expected, not an error to act on).

If `indexedBlock` is frozen with NEITHER of those recovery messages showing
up, or with `"fallback pool endpoint errored"` recurring for every configured
endpoint continuously with no progress between cooldowns, every RPC provider
is likely degraded at once — that needs upstream escalation (ArrowRPC /
Robinhood Chain RPC operators), not a restart. In that case, check chainlist.org
and the chain's own docs for additional public endpoints and add them as
`RPC_HTTP_TERTIARY` / `RPC_HTTP_QUATERNARY` / `RPC_HTTP_QUINARY` in `.env`
(never hardcoded) — `fallbackUrls()` in `packages/shared/src/chain.ts` picks
up whichever are set. The same shared client (`makePublicClient`, used by
backfill, the API's `ctx.client`, and the head-follower's own normal-path
`rpc`) also fails over across this same list on any thrown error — via
viem's `fallback()` wrapper, which only moves past the currently-preferred
URL when a call actually throws, not concurrently and not just because a
later entry might be faster. In practice that means a NEW entry near the
end of the list (like `RPC_HTTP_QUINARY` today) sees close to zero traffic
through this path while everything ahead of it stays healthy — it only
starts absorbing load once something earlier in the chain starts erroring.

### RPC_HTTP_QUINARY — Validation Cloud (added 2026-07-24)

Keyed (`https://mainnet.robinhood.validationcloud.io/v1/<key>`), on a
pay-as-you-go plan (operator's choice — Validation Cloud's free tier is
0-50M compute units/month, larger than any other configured endpoint's, but
this deployment is on pay-as-you-go instead). Verified the same way as
`RPC_HTTP_TERTIARY`/`_QUATERNARY` before it: correct chain id (`0x1237` =
4663), fresh/advancing block numbers, JSON-RPC batching, real
`eth_getBlockByNumber`+`eth_getBlockReceipts` (the actual pair the indexer
calls), and concurrency — 40 concurrent `eth_blockNumber` calls direct
against the endpoint alone completed in 0.4s with zero errors, comfortably
above what any single free public endpoint in this pool has tolerated.

**Measured before/after (2026-07-24, primary healthy at the time — not
during an outage): no meaningful throughput change.** Head: ~10.5 → ~10.9
blocks/s. Backfill (was mid-way through filling a historical gap at the
time): ~14.8 → ~16.7 blocks/s — both deltas are within normal run-to-run
noise, not a real effect. This is expected, not a sign the integration
failed: under healthy-primary conditions the binding constraint is
`INDEXER_MAX_RPS` (currently 80, deliberately left untouched — see below),
not upstream provider capacity, and the fallback pool this endpoint joined
is a **recovery** mechanism (used when the primary is stuck) rather than a
steady-state load spreader — confirmed no `"fetched via fallback pool"` log
line appeared at all during the measurement window, i.e. Validation Cloud
sat configured-but-idle the whole time, exactly as designed while nothing
upstream was actually failing.

Validation Cloud's real payoff, per the design that already proved out
`RPC_HTTP_TERTIARY`/`_QUATERNARY` (docs/ops.md history above: 1 fallback
capped incident recovery around 1.5-2 blocks/s, 3 fallbacks raised it to
4.2-4.9), is a **fourth** concurrent destination for the fallback pool to
spread load across during the NEXT primary-stuck incident, not a number
that shows up in a same-day before/after taken while everything is
healthy. That couldn't be measured directly here without deliberately
breaking a working primary on production, which wasn't done. If a future
incident happens with this endpoint configured, `grep 'fetched via
fallback pool'` in the indexer logs will show whether/how much it
contributed, the same way `_TERTIARY`/`_QUATERNARY`'s contribution was
confirmed during the 2026-07-22 incident.

**Whether the tier-up is worth paying for**: the 40-concurrent burst test
above says Validation Cloud's own ceiling is well above what's been seen
from the free public endpoints in this pool, which is a good sign for
incident-recovery headroom specifically — but pay-as-you-go billing means
cost scales with actual usage, and under healthy-primary conditions this
endpoint is measured above to see near-zero traffic, so ongoing cost
should be minimal until an incident actually happens. Revisit after the
next real primary-stuck incident with real recovery-throughput numbers in
hand, rather than deciding on today's idle-endpoint measurement alone.

Deploy a code update:

```sh
cd ~/4663scan && git pull
pnpm install
pnpm db:migrate
pnpm --filter @4663scan/web build     # NEXT_PUBLIC_API_URL is baked at build
pm2 restart indexer api web
```

## Database

```sh
pnpm db:migrate                        # drizzle-kit against DATABASE_URL
pnpm --filter @4663scan/indexer retention:once   # manual retention pass
```

- `DB_EMBEDDED=false` in production `.env` — `pnpm run setup`/`db:start` are
  no-ops; system Postgres owns the data.
- The `logs` table is partitioned; **never** edit it via `drizzle-kit
  generate` (docs/architecture.md).
- Slim-tier hydration requires an **archival** RPC upstream; if the primary
  ever stops serving historical blocks, demoted tx/block detail pages return
  502 until a fallback archival endpoint is configured.

## Disk

The tiering design (docs/architecture.md) bounds disk as
`hot window × chain rate + slim history`. Checks:

```sh
df -h /
sudo -u postgres psql fourscan -c "
  select relname, pg_size_pretty(pg_total_relation_size(c.oid)) size
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and relkind in ('r','p','i')
  order by pg_total_relation_size(c.oid) desc limit 15;"
sudo -u postgres psql fourscan -c "
  select count(*) partitions, coalesce(min(relname),'-') oldest
  from pg_class where relname ~ '^logs_p[0-9]+$';"
```

Expect roughly `HOT_WINDOW_SECONDS / (500000 × block-time)` + 1–2 logs
partitions (≈12–14 at a 7-day window). If disk pressure rises, lower
`HOT_WINDOW_SECONDS` (then `pm2 restart indexer api`) — the next retention
passes demote/drop down to the new window. Growth of the forever-tier
(`transactions` slim rows) is the long-term driver; see the capacity model
in docs/architecture.md before changing hardware.

Retention health: `/v1/status` → `tiering.transfersPrunedThrough` should
track ~`HOT_WINDOW_SECONDS` behind head; a stall means the retention worker
is erroring (check `pm2 logs indexer`).

## Backups

Everything except five small tables is re-derivable from chain via genesis
backfill. Nightly dump of the never-pruned data is enough
(`address_token_seen` is re-derivable in principle, but only by a full
re-backfill — dump it, it's pairs-only tiny):

```sh
pg_dump "$DATABASE_URL" -t tokens -t stock_tokens -t address_labels \
  -t method_signatures -t address_token_seen -Fc \
  -f ~/backups/4663scan-meta-$(date +%F).dump
```

## Security posture

- Externally reachable ports must remain **22, 80, 443 only**
  (`sudo ufw status`; verify from outside with an external scanner, not from
  the box).
- Postgres, API (4663) and web (3000) bind loopback only. After any config
  change: `ss -tlnp | grep -vE '127.0.0.1|\[::1\]'` should show only sshd
  and caddy.
- fail2ban active for sshd (`sudo fail2ban-client status sshd`).

## Cloudflare

DNS is proxied (orange cloud); TLS is Caddy with DNS-01 via a Cloudflare API
token (`/etc/caddy/cloudflare.env`, `CF_API_TOKEN`, Zone→DNS→Edit only —
rotate in the CF dash if leaked). Cache rules (set in CF dashboard):

1. `4663scan.io/api/v1/stream*` — **Bypass cache** (SSE).
2. `4663scan.io/api/v1/search*`, `/api/v1/status` — Bypass.
3. Everything else — **respect origin Cache-Control**. The API already sends
   `immutable, max-age=1y` for deep-confirmed tx/block responses and short
   TTLs near head, and the web layer sends `s-maxage` on /tx and /block
   pages; origin headers are the single source of truth, so no aggressive
   CF-side TTL overrides.

## Token submissions

`POST /v1/submissions` (public, rate-limited to 5/IP/day) lets anyone propose
a token listing (contract address, project name, logo, website, socials,
description, contact email). The address must already be a deployed contract
on-chain or the request is rejected; an uploaded/URL-fetched logo is always
decoded and re-encoded through `sharp` before being written to
`apps/web/public/submission-logos/` — raw submitted bytes are never persisted
or served. A row starts at `status='awaiting_payment'` in the
`token_submissions` table — since M8, a submission does not enter the review
queue until an on-chain payment is verified (see below); it then becomes
`status='pending'`. **Nothing is ever auto-published either way**. Review
from the API box:

```sh
pnpm --filter @4663scan/api review-submissions list                # pending (default) — i.e. paid, awaiting review
pnpm --filter @4663scan/api review-submissions list awaiting_payment  # unpaid, ignore these for review
pnpm --filter @4663scan/api review-submissions list all             # everything, newest first
pnpm --filter @4663scan/api review-submissions show <id>            # full detail incl. payment info
pnpm --filter @4663scan/api review-submissions approve <id> "note"
pnpm --filter @4663scan/api review-submissions reject <id> "note"
```

`approve`/`reject` only flip the row's status (idempotency guard: fails if
the row isn't still `pending`; approving/rejecting an `awaiting_payment` row
is refused outright with an explicit "still awaiting payment" error — there
is no way to approve an unpaid submission). Approving a submission does
**not** by itself add anything to the live tokens/stock listing — that's a
deliberate separate step (there is no auto-publish path by design, since
submitted data is unverified third-party input).

### Paid submissions (M8)

A submitter must send `SUBMISSION_PRICE_USD` worth of `PAYMENT_TOKEN_SYMBOL`
(both in `.env`) to `TREASURY_ADDRESS`, then paste the resulting tx hash on
the payment page the form redirects to. `POST /v1/submissions/:id/verify-payment`
(rate-limited 20/IP/hour) checks, entirely server-side and read-only (no
private key exists anywhere in this system — it never signs or sends
anything):

- the tx exists on chain 4663 and its receipt status is success
- the tx is no older than `PAYMENT_MAX_TX_AGE_SECONDS`
- summed across every matching ERC-20 `Transfer` log in that tx (not the raw
  `tx.to`, which for an ERC-20 call is the token contract, not the payer's
  intended recipient): `token == PAYMENT_TOKEN_ADDRESS` and
  `to == TREASURY_ADDRESS`
- the summed amount is `>= price_quoted_usd` (frozen per-submission at form
  time, in `token_submissions.price_quoted_usd`) converted to raw units
- the quote (`quote_expires_at`, `PAYMENT_QUOTE_WINDOW_HOURS` after
  submission) hasn't expired
- the tx hash has never been used by any other submission — enforced by a
  UNIQUE index on `payment_tx_hash` at the schema level, so a replay fails
  atomically at the database, not just via an earlier in-app check

**Changing the price**: edit `SUBMISSION_PRICE_USD` in `.env`, `pm2 restart
api`. Only NEW submissions get the new price — any row still
`awaiting_payment` keeps the `price_quoted_usd` it was given at creation
until its quote expires (by design: the charter behind this required a
price frozen per submission, not a live-read price at verification time).

**Changing the treasury address**: edit `TREASURY_ADDRESS` in `.env`, `pm2
restart api`. Rows already `awaiting_payment` under the OLD address will
never verify (their payer was told the old address) — either have them
resubmit, or manually verify + update via SQL (below) if you can confirm
the old address did receive their payment before the change.

**Looking up a payment**: `review-submissions show <id>` prints
`price_quoted_usd`, `quote_expires_at`, and (once paid)
`paid_amount`/`paid_asset`/`paid_at`/`payment_tx_hash`. For anything not on
that view (e.g. finding which submission a given tx hash belongs to):

```sh
psql "$DATABASE_URL" -c "select id, status, project_name, contact_email from token_submissions where payment_tx_hash = decode('<hash-without-0x>', 'hex');"
```

**Underpayment**: rejected outright, never partially accepted — the
submitter sees the exact amount received vs. required. If a legitimate
submitter split their payment across two transactions (uncommon, since the
form only accepts one hash), verify both txs independently via a block
explorer, then manually move the row to `pending` and fill in the payment
columns yourself — there is no CLI path for this narrow multi-tx case by
design (the schema and verifier assume one lump-sum tx):

```sh
psql "$DATABASE_URL" -c "update token_submissions set status='pending', payment_tx_hash=decode('<hash-without-0x>','hex'), paid_amount='<raw-units>', paid_asset='USDG', paid_at=now() where id=<id> and status='awaiting_payment';"
```

**Disputed submission / refund**: reject the row with a `reviewNote`
explaining why. Refunds are always a fully manual, out-of-band action — send
`PAYMENT_TOKEN_SYMBOL` back from your own treasury wallet using your own
tooling; nothing in this codebase can move funds (by design, per the "no
private keys anywhere in this system" constraint). The refund-policy wording
shown to submitters before they pay (on `/submit-token`) is a placeholder —
replace `[OPERATOR: insert refund policy wording here before launch]` in
`apps/web/app/submit-token/page.tsx` with real wording before announcing
this feature publicly, and swap `TREASURY_ADDRESS` in `.env` for a real
wallet you control (it currently defaults to an obvious placeholder,
`0x1111…1111`, and payments will never verify against it since nobody has
ever sent funds there).

## Smoke tests

```sh
pnpm smoke            # live-stack e2e (indexing, API, web, SSE, search)
pnpm smoke:tiering    # demotion/pruning/hydration; see script header for
                      # the shrunken-window .env it expects (dev only —
                      # do not run against the production DB)
```
