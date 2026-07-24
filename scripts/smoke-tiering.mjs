#!/usr/bin/env node
/**
 * Storage-tiering smoke test (docs/architecture.md). Run against a live
 * stack (pnpm dev) whose .env shrinks the tiers so demotion is observable in
 * minutes, e.g.:
 *
 *   HOT_WINDOW_SECONDS=600 CONFIRM_DEPTH=2000 RETENTION_ENABLED=false
 *
 * RETENTION_ENABLED=false lets this script trigger the pass deterministically
 * via `pnpm --filter @4663scan/indexer retention:once`. The stack must have
 * been head-indexing longer than the window (plus CONFIRM_DEPTH of blocks)
 * so head-written FULL rows exist past the cutoff; exits 2 (not a failure)
 * when it's simply too early to demote anything.
 *
 * Asserts: full→slim demotion, logs partition drops, non-stock transfer
 * pruning, stock-transfer survival, and full detail still served via the
 * API's ephemeral RPC hydration for demoted txs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_URL || 'http://localhost:4663';
const WEB = process.env.WEB_URL || 'http://localhost:3000';

// Minimal .env parsing (matches scripts/db.mjs).
const envFile = {};
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) envFile[m[1]] = m[2];
  }
} catch {
  // .env optional; defaults below.
}
const getenv = (k, dflt) => process.env[k] ?? envFile[k] ?? dflt;
const DATABASE_URL = getenv(
  'DATABASE_URL',
  'postgres://fourscan:fourscan@127.0.0.1:54663/fourscan',
);
const HOT_WINDOW = Number(getenv('HOT_WINDOW_SECONDS', '604800'));

// postgres.js from the shared package's dependency tree (root has no deps).
const require = createRequire(join(ROOT, 'packages/shared/package.json'));
const { default: postgres } = await import(require.resolve('postgres'));
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

const bufToHex = (b) => '0x' + Buffer.from(b).toString('hex');

let failures = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

async function getJson(path) {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

const done = async (code) => {
  await sql.end();
  process.exit(code);
};

console.log('1. Stack is up and a demotable full-detail range exists');
const status = await getJson('/v1/status');
ok('API status', status.chainId === 4663, `indexed #${status.indexedBlock}`);

const cutoffTs = Math.floor(Date.now() / 1000) - HOT_WINDOW;
const [candidate] = await sql`
  select hash, block_number, timestamp, "from"
  from transactions
  where input is not null and timestamp < ${cutoffTs}
  order by block_number asc limit 1`;
if (!candidate) {
  console.log(
    `\nNothing old enough to demote yet (window ${HOT_WINDOW}s). ` +
      'Let the stack index past the window and re-run. Exit 2.',
  );
  await done(2);
}
const txHash = bufToHex(candidate.hash);
const txFrom = bufToHex(candidate.from);
// postgres.js returns int8 as string; every arithmetic use needs a number.
const candidateBlock = Number(candidate.block_number);
console.log(`  candidate tx ${txHash} @ block ${candidateBlock}`);

// Pre-retention snapshots for survival/pruning asserts.
const [stockTransfer] = await sql`
  select t.block_number, t.log_index, t.token_address
  from token_transfers t
  join stock_tokens s on s.token_address = t.token_address
  where t.timestamp < ${cutoffTs}
  order by t.block_number asc limit 1`;

// Partitions only drop once their ENTIRE 500k-block range passes the window,
// which a short smoke run never reaches naturally — so demonstrate the drop
// machinery on a synthetic lowest partition (any real chain data is millions
// of blocks above it; retention removes it within this same run).
await sql`create table if not exists logs_p0 partition of logs for values from (0) to (500000)`.catch(
  () => {},
);
await sql`
  insert into logs (block_number, log_index, tx_hash, tx_index, address, data)
  values (100, 0, '\\xab'::bytea, 0, '\\xcd'::bytea, '\\x'::bytea)
  on conflict do nothing`;

console.log('2. Retention pass demotes it');
try {
  execFileSync('pnpm', ['--filter', '@4663scan/indexer', 'retention:once'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300_000,
  });
} catch (err) {
  ok('retention:once ran', false, String(err));
  await done(1);
}

const [after] = await sql`
  select input, block_hash, nonce, gas, status, tx_index, value, method_id
  from transactions where hash = ${candidate.hash}`;
ok('tx demoted to slim (input NULL)', after && after.input === null);
ok('slim keeps identity fields', after && after.tx_index !== null && after.value !== null);
ok('gas detail dropped', after && after.gas === null && after.nonce === null);
const [blockAfter] = await sql`
  select parent_hash, hash, timestamp, tx_count from blocks
  where number = ${candidateBlock}`;
ok('block demoted (parent_hash NULL, hash kept)', blockAfter && blockAfter.parent_hash === null && blockAfter.hash !== null);
const [p0] = await sql`
  select count(*)::int as n from pg_class where relname = 'logs_p0'`;
ok('fully-expired logs partition dropped (synthetic p0)', p0.n === 0);
// Real partitions lag demotion by up to one width (500k blocks ≈ 15h): only
// ranges entirely past the window may drop. Nothing older may survive.
const [staleLogs] = await sql`
  select count(*)::int as n from logs where block_number < ${candidateBlock - 500000}`;
ok('no logs older than cutoff minus one partition width', staleLogs.n === 0);
const [nonStockLeft] = await sql`
  select count(*)::int as n
  from token_transfers t
  where t.timestamp < ${cutoffTs}
    and not exists (select 1 from stock_tokens s where s.token_address = t.token_address)
    and not exists (select 1 from tokens k where k.address = t.token_address and k.is_stock_token)`;
ok('non-stock transfers pruned past window', nonStockLeft.n === 0, `${nonStockLeft.n} left`);
if (stockTransfer) {
  const [still] = await sql`
    select 1 as one from token_transfers
    where block_number = ${stockTransfer.block_number}
      and log_index = ${stockTransfer.log_index}`;
  ok('stock transfer survived retention', Boolean(still));
} else {
  console.log('  (no pre-window stock transfer observed; survival assert skipped)');
}

console.log('3. API serves the demoted tx with full detail (RPC hydration)');
const detail = await getJson(`/v1/txs/${txHash}`);
ok('detail resolves', detail.hash === txHash);
ok('calldata hydrated', typeof detail.input === 'string' && detail.input.startsWith('0x'));
ok('logs hydrated', Array.isArray(detail.logs));
ok('gas hydrated', detail.gasUsed != null);

console.log('4. Demoted tx still in address history and lists');
// Cursor just above the candidate's block: the demoted tx must be on the
// first page regardless of how busy the address is near head.
const addrTxs = await getJson(
  `/v1/addresses/${txFrom}/txs?limit=100&cursor=${candidateBlock + 1}_0`,
);
ok(
  'address history serves the demoted tx',
  addrTxs.items.some((t) => t.hash === txHash),
);
const blockTxs = await getJson(`/v1/blocks/${candidateBlock}/txs?limit=100`);
ok('block tx list serves slim rows', blockTxs.items.some((t) => t.hash === txHash));

console.log('5. Web page for the demoted tx');
const res = await fetch(`${WEB}/tx/${txHash}`, { signal: AbortSignal.timeout(20_000) });
await res.text();
ok('web /tx renders', res.status === 200, `status ${res.status}`);

console.log(failures === 0 ? '\nTIERING SMOKE PASS' : `\nTIERING SMOKE FAIL (${failures} failures)`);
await done(failures === 0 ? 0 : 1);
