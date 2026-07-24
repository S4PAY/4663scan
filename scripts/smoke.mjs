#!/usr/bin/env node
/**
 * End-to-end smoke test against the locally running stack (pnpm dev).
 * Verifies the M1 exit criteria: indexer streaming live mainnet blocks,
 * API serving, and real tx/address/block pages resolving under one second.
 */
const API = process.env.API_URL || 'http://localhost:4663';
const WEB = process.env.WEB_URL || 'http://localhost:3000';

let failures = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

async function getJson(path) {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function timePage(path) {
  const t0 = performance.now();
  const res = await fetch(WEB + path, { signal: AbortSignal.timeout(15_000) });
  await res.text();
  return { status: res.status, ms: performance.now() - t0 };
}

console.log('1. API status');
const s1 = await getJson('/v1/status');
ok('chainId 4663', s1.chainId === 4663);
ok('indexed block present', s1.indexedBlock > 0, `#${s1.indexedBlock}`);

console.log('2. Indexer is live (indexed head advances within 5s)');
await new Promise((r) => setTimeout(r, 5000));
const s2 = await getJson('/v1/status');
ok('head advanced', s2.indexedBlock > s1.indexedBlock, `${s1.indexedBlock} → ${s2.indexedBlock}`);

console.log('3. Real entities from the live chain');
const txs = await getJson('/v1/txs?limit=1');
const tx = txs.items[0];
ok('recent tx exists', Boolean(tx?.hash), tx?.hash);
const txDetail = await getJson(`/v1/txs/${tx.hash}`);
ok('tx detail resolves', txDetail.hash === tx.hash);
const addr = tx.from.address;
const addrSummary = await getJson(`/v1/addresses/${addr}`);
ok('address resolves with balance', typeof addrSummary.balanceWei === 'string');
const block = await getJson(`/v1/blocks/${tx.blockNumber}`);
ok('block resolves', block.number === tx.blockNumber);

console.log('4. SSE stream delivers a block event within 10s');
const sse = await new Promise(async (resolve) => {
  const timer = setTimeout(() => resolve(false), 10_000);
  try {
    const res = await fetch(API + '/v1/stream', { signal: AbortSignal.timeout(11_000) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: block')) {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        resolve(true);
        return;
      }
    }
    resolve(false);
  } catch {
    resolve(false);
  }
});
ok('block event received', sse);

console.log('5. Web pages resolve under 1s (after warm-up)');
const pages = ['/', `/tx/${tx.hash}`, `/address/${addr}`, `/block/${tx.blockNumber}`, '/tokens'];
for (const p of pages) await timePage(p); // warm dev-mode compile
for (const p of pages) {
  const { status, ms } = await timePage(p);
  ok(`${p}`, status === 200 && ms < 1000, `${status} in ${ms.toFixed(0)}ms`);
}

console.log('6. Search resolves a stock ticker');
const search = await getJson('/v1/search?q=NVDA');
ok('NVDA found as stock token', search.results.some((r) => r.type === 'token' && r.isStockToken));

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
