import { decodeFunctionData } from 'viem';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { erc20Abi, signatureName } from '@4663scan/shared/abi';
import { methodSignatures } from '@4663scan/shared/db/schema';
import type { DecodedMethod, DecodedParam } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import { TtlMap, dedupe } from '../lib/ttl.js';
import { asHex } from '../lib/params.js';

interface SigInfo {
  signature: string;
  name: string;
  source: 'known' | 'openchain';
}

export interface DecodeResult {
  decoded: DecodedMethod | null;
  /**
   * False when resolution failed transiently (openchain unreachable): the
   * response content could still change, so it must not be cached immutably.
   */
  definitive: boolean;
}

type Erc20Fn = Extract<(typeof erc20Abi)[number], { type: 'function' }>;
const erc20Functions: Erc20Fn[] = erc20Abi.filter(
  (f): f is Erc20Fn => f.type === 'function',
);

function stringifyAbiValue(type: string, value: unknown): string {
  if (typeof value === 'string') {
    return type === 'address' ? value.toLowerCase() : value;
  }
  if (
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

/** Full ABI decode is only attempted for ERC-20 selectors we hold ABIs for. */
function tryDecodeErc20Params(input: string): DecodedParam[] | null {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: asHex(input) });
    const fn = erc20Functions.find((f) => f.name === decoded.functionName);
    if (!fn) return null;
    const args = (decoded.args ?? []) as readonly unknown[];
    return fn.inputs.map((inp, i) => ({
      name: inp.name && inp.name.length > 0 ? inp.name : `arg${i}`,
      type: inp.type,
      value: stringifyAbiValue(inp.type, args[i]),
    }));
  } catch {
    return null;
  }
}

/** Openchain sits on the hot tx-detail path — keep its budget tight. */
const OPENCHAIN_TIMEOUT_MS = 1500;
/** Transient-failure memo: skip re-lookups of a selector for this long. */
const FAILURE_MEMO_MS = 45_000;
/** Circuit breaker: after this many consecutive failures, back off. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
/** Definitive negatives are re-checked upstream after this age. */
const NEGATIVE_RECHECK_MS = 7 * 86_400_000;

export function makeDecode(ctx: AppContext) {
  // null = definitive negative (from a negative DB row); a transient
  // openchain failure is memoized separately (failMemo) with a short TTL.
  const sigCache = new TtlMap<string, SigInfo | null>(60_000, 5000);
  const nameCache = new TtlMap<string, string | null>(60_000, 5000);
  const failMemo = new TtlMap<string, true>(FAILURE_MEMO_MS, 2000);
  let consecutiveFailures = 0;
  let breakerOpenUntil = 0;

  function rowToSig(row: {
    signature: string | null;
    name: string | null;
    source: string | null;
  }): SigInfo | null {
    if (!row.signature) return null;
    return {
      signature: row.signature,
      name: row.name ?? signatureName(row.signature),
      source: row.source === 'known' ? 'known' : 'openchain',
    };
  }

  function markFailure(selector: string): undefined {
    failMemo.set(selector, true);
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
    return undefined;
  }

  async function lookupOpenchain(selector: string): Promise<string | null | undefined> {
    // undefined = network/HTTP failure (never persisted as a DB negative).
    if (Date.now() < breakerOpenUntil) return undefined;
    if (failMemo.get(selector)) return undefined;
    try {
      const res = await fetch(
        `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`,
        { signal: AbortSignal.timeout(OPENCHAIN_TIMEOUT_MS) },
      );
      if (!res.ok) return markFailure(selector);
      const body = (await res.json()) as {
        result?: { function?: Record<string, { name: string }[] | null> };
      };
      consecutiveFailures = 0;
      return body.result?.function?.[selector]?.[0]?.name ?? null;
    } catch {
      return markFailure(selector);
    }
  }

  async function resolveSignature(selector: string): Promise<SigInfo | null | undefined> {
    const cached = sigCache.get(selector);
    if (cached !== undefined) return cached;
    return dedupe(`sig:${selector}`, async () => {
      const rows = await ctx.db
        .select()
        .from(methodSignatures)
        .where(inArray(methodSignatures.selector, [selector]))
        .limit(1);
      const row = rows[0];
      if (row) {
        const sig = rowToSig(row);
        // Aged definitive negatives get one upstream re-check: openchain may
        // have learned the signature since checkedAt.
        const stale =
          sig === null &&
          row.checkedAt.getTime() < Date.now() - NEGATIVE_RECHECK_MS;
        if (!stale) {
          sigCache.set(selector, sig);
          return sig;
        }
      }
      const found = await lookupOpenchain(selector);
      if (found === undefined) {
        // Transient failure: an existing DB negative stays authoritative.
        if (row) {
          sigCache.set(selector, null);
          return null;
        }
        return undefined;
      }
      const values = {
        selector,
        signature: found,
        name: found ? signatureName(found) : null,
        source: 'openchain',
        checkedAt: new Date(),
      };
      if (row) {
        // Refresh the negative row (never clobber a positive one).
        await ctx.db
          .update(methodSignatures)
          .set(values)
          .where(
            and(
              eq(methodSignatures.selector, selector),
              isNull(methodSignatures.signature),
            ),
          );
      } else {
        await ctx.db.insert(methodSignatures).values(values).onConflictDoNothing();
      }
      const sig: SigInfo | null = found
        ? { signature: found, name: signatureName(found), source: 'openchain' }
        : null;
      sigCache.set(selector, sig);
      return sig;
    });
  }

  async function decodeTx(
    methodId: string | null,
    input: string,
  ): Promise<DecodeResult> {
    if (!methodId) return { decoded: null, definitive: true };
    const selector = methodId.toLowerCase();
    const sig = await resolveSignature(selector);
    // undefined = transient upstream failure: the caller must not cache the
    // response as immutable, a later attempt may resolve.
    if (sig === undefined) return { decoded: null, definitive: false };
    if (sig === null) return { decoded: null, definitive: true };
    return {
      decoded: {
        selector,
        signature: sig.signature,
        name: sig.name,
        source: sig.source,
        params: tryDecodeErc20Params(input),
      },
      definitive: true,
    };
  }

  /**
   * True when every selector has a definitive negative DB row, i.e. a
   * methodName:null rendering of it can never change. A selector with a
   * positive row (a stale cached null) or no row at all disqualifies.
   */
  async function selectorsKnownNegative(selectors: string[]): Promise<boolean> {
    if (selectors.length === 0) return true;
    const unique = [...new Set(selectors)];
    const rows = await ctx.db
      .select({ selector: methodSignatures.selector })
      .from(methodSignatures)
      .where(
        and(
          inArray(methodSignatures.selector, unique),
          isNull(methodSignatures.signature),
        ),
      );
    return rows.length === unique.length;
  }

  /** DB-only batched selector → method-name lookup for tx list views. */
  async function resolveMethodNames(
    selectors: string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const s of new Set(selectors)) {
      const hit = nameCache.get(s);
      if (hit !== undefined) out.set(s, hit);
      else missing.push(s);
    }
    if (missing.length > 0) {
      const rows = await ctx.db
        .select()
        .from(methodSignatures)
        .where(inArray(methodSignatures.selector, missing));
      const found = new Map(rows.map((r) => [r.selector, r]));
      for (const s of missing) {
        const row = found.get(s);
        const name = row ? (rowToSig(row)?.name ?? null) : null;
        // Selectors with no DB row yet get a short negative TTL so a later
        // detail-view openchain resolution shows up in lists quickly.
        nameCache.set(s, name, row ? 60_000 : 10_000);
        out.set(s, name);
      }
    }
    return out;
  }

  return { decodeTx, resolveMethodNames, selectorsKnownNegative };
}

export type Decode = ReturnType<typeof makeDecode>;
