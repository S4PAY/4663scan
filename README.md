<p align="center">
  <img src="apps/web/public/og-banner.png" alt="4663scan — Robinhood Chain explorer" width="100%" />
</p>

# 4663scan

A block explorer for **Robinhood Chain** (Arbitrum Orbit L2, chain ID 4663) —
built to index the chain's live tip in real time and to treat tokenized
stocks as first-class, not as an afterthought bolted onto a generic ERC-20
list.

**Live at [4663scan.io](https://4663scan.io)** · **[API docs](https://4663scan.io/docs)**

> No live screenshot is included here — this README was written without
> access to a browser to capture one. Visit the link above to see it.

## What makes it different

- **Verified stock tokens, with counterfeit detection.** Robinhood's
  tokenized-stock tokens are `BeaconProxy` contracts deployed by a single
  on-chain `StockFactory`. Anything on this chain that merely *looks* like a
  stock token by name ("Apple • Robinhood Token") is worthless as a signal —
  a copycat can set its own name to whatever it wants. So 4663scan never
  trusts a name match: every candidate is verified by asking the factory
  itself whether it deployed that exact address, and only a token the
  factory vouches for is ever labeled as real. Lookalikes that fail this
  check are indexed like any other ERC-20 — never shown as verified.
- **A live-tip home feed, not a lagging index.** Free RPC can't sustain
  indexing a ~100ms-block chain in real time forever, so most explorers
  either fall behind quietly or show a stale "last indexed" number as if it
  were current. 4663scan's home feed and list pages read the newest blocks
  straight from RPC on every request instead of waiting for the database to
  catch up — the tip is always the tip. Historical browsing still uses the
  indexed database, which is exactly what it's good at.
- **Real contract pages.** Bytecode identity, ERC-20/721 detection, proxy
  detection (EIP-1967/EIP-1822, resolved to the implementation), creator
  lookup, and verified source — checked against Sourcify and Blockscout —
  with tabs for source code, an interactive read-only console for any `view`
  function, and decoded event logs.
- **A public, documented API.** Every read endpoint the site itself uses is
  open to anyone: rate-limited, CORS-enabled, no signup, no key. See
  [4663scan.io/docs](https://4663scan.io/docs) for the full reference with
  real example requests and responses.

## Stack

- **pnpm monorepo** — `apps/indexer`, `apps/api`, `apps/web`, `packages/shared`
- **Indexer** — TypeScript + [viem](https://viem.sh); WSS head subscription
  with HTTP polling fallback across a pool of independent RPC providers;
  head-first indexing with a resumable background backfill toward genesis;
  a single global rate limiter shared across every RPC consumer
- **Database** — Postgres 16 via [Drizzle](https://orm.drizzle.team)
  (embedded, user-space Postgres for local dev; `DB_EMBEDDED=false` points
  at a system server). Storage is tiered — full detail for a rolling hot
  window, compact "slim" rows kept forever, stock-token transfers never
  pruned — see `docs/architecture.md`
- **API** — [Fastify](https://fastify.dev), read-mostly REST + one SSE
  stream, aggressive response caching, global + per-route rate limiting
- **Web** — [Next.js](https://nextjs.org) (App Router) + Tailwind, mobile-first

## Quickstart

Requires Node ≥22 and pnpm.

```sh
pnpm install
cp .env.example .env      # defaults work out of the box for local dev
pnpm setup                # starts embedded Postgres, runs migrations, seeds labels
pnpm dev                  # indexer + api + web, concurrently
```

- Web: http://localhost:3000
- API: http://localhost:4663/v1/status (docs at http://localhost:3000/docs)
- Postgres: `postgres://fourscan:fourscan@127.0.0.1:54663/fourscan`

The Postgres data directory lives at `~/.local/share/4663scan/pgdata` by
default (override with `PGDATA_DIR`); it must be on a native Linux filesystem.

`pnpm smoke` runs an end-to-end smoke test against live mainnet.

## Notes

- The indexer starts at the current chain head and works backwards in the
  background. Lookups older than the index start are lazily fetched from RPC
  and cached permanently once deep enough to be final.
- All RPC endpoints are configured via `.env` (see `.env.example`) — the
  indexer never exceeds `INDEXER_MAX_RPS` requests/second in total, split
  across every configured provider.

## License

[GNU AGPL v3](LICENSE). It's copyleft specifically because this is a
network service: the AGPL's key difference from plain GPL is that running a
*modified* version of this code to serve other users over a network counts
as distribution, so anyone who stands up a competing instance from a fork
has to publish their changes too, not just keep them behind their own API.
A permissive license (MIT/Apache) wouldn't require that — anyone could take
this, modify it, and run a closed competing explorer with no obligation to
share anything back. AGPL doesn't stop someone from forking and running a
competitor (nothing can, once code is public) — it just means they have to
do it in the open.
