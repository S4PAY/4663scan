import { inArray } from 'drizzle-orm';
import { addressLabels, tokens } from '@4663scan/shared/db/schema';
import type { TokenRef } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import { TtlMap } from '../lib/ttl.js';

/**
 * Batched address-label and token-metadata resolution with a 60s cache.
 * A cached `null` means "looked up, nothing known" — distinct from a miss.
 */
export function makeMeta(ctx: AppContext) {
  const labelCache = new TtlMap<string, string | null>(60_000, 5000);
  const tokenCache = new TtlMap<string, TokenRef | null>(60_000, 5000);

  async function resolveLabels(
    addresses: string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const a of new Set(addresses)) {
      const hit = labelCache.get(a);
      if (hit !== undefined) out.set(a, hit);
      else missing.push(a);
    }
    if (missing.length > 0) {
      const [labelRows, tokenRows] = await Promise.all([
        ctx.db
          .select({ address: addressLabels.address, label: addressLabels.label })
          .from(addressLabels)
          .where(inArray(addressLabels.address, missing)),
        ctx.db
          .select({ address: tokens.address, name: tokens.name, symbol: tokens.symbol })
          .from(tokens)
          .where(inArray(tokens.address, missing)),
      ]);
      const found = new Map<string, string>();
      for (const t of tokenRows) {
        const label = t.symbol ?? t.name;
        if (label) found.set(t.address, label);
      }
      // address_labels wins over token-derived labels.
      for (const r of labelRows) found.set(r.address, r.label);
      for (const a of missing) {
        const label = found.get(a) ?? null;
        labelCache.set(a, label);
        out.set(a, label);
      }
    }
    return out;
  }

  async function resolveTokenRefs(
    addresses: string[],
  ): Promise<Map<string, TokenRef | null>> {
    const out = new Map<string, TokenRef | null>();
    const missing: string[] = [];
    for (const a of new Set(addresses)) {
      const hit = tokenCache.get(a);
      if (hit !== undefined) out.set(a, hit);
      else missing.push(a);
    }
    if (missing.length > 0) {
      const rows = await ctx.db
        .select({
          address: tokens.address,
          name: tokens.name,
          symbol: tokens.symbol,
          decimals: tokens.decimals,
          isStockToken: tokens.isStockToken,
        })
        .from(tokens)
        .where(inArray(tokens.address, missing));
      const found = new Map<string, TokenRef>(rows.map((r) => [r.address, r]));
      for (const a of missing) {
        const ref = found.get(a) ?? null;
        tokenCache.set(a, ref);
        out.set(a, ref);
      }
    }
    return out;
  }

  return { resolveLabels, resolveTokenRefs };
}

export type Meta = ReturnType<typeof makeMeta>;
