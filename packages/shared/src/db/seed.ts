/**
 * Seeds address labels, the known-selector cache, and the stock-token
 * registry. Idempotent: safe to re-run any time (upserts).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { KNOWN_SELECTORS, signatureName } from '../abi/index.js';
import { addressLabels, methodSignatures, stockTokens, tokens } from './schema.js';
import { makeDb } from './index.js';

interface LabelEntry {
  address: string;
  label: string;
  category: string;
  source?: string;
}

interface StockRegistry {
  issuerAddresses: { address: string; label?: string }[] | string[];
  tokens: {
    address: string;
    ticker: string;
    companyName?: string;
    issuerAddress?: string;
  }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { db, sql: pg } = makeDb({ max: 2 });

  const labels: LabelEntry[] = JSON.parse(
    readFileSync(join(HERE, '..', 'labels.json'), 'utf8'),
  );
  const registry: StockRegistry = JSON.parse(
    readFileSync(join(HERE, '..', 'stock-registry.json'), 'utf8'),
  );

  if (labels.length > 0) {
    await db
      .insert(addressLabels)
      .values(
        labels.map((l) => ({
          address: l.address.toLowerCase(),
          label: l.label,
          category: l.category,
          source: l.source ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: addressLabels.address,
        set: {
          label: sql`excluded.label`,
          category: sql`excluded.category`,
          source: sql`excluded.source`,
        },
      });
  }

  const selectorRows = Object.entries(KNOWN_SELECTORS).map(
    ([selector, signature]) => ({
      selector: selector.toLowerCase(),
      signature,
      name: signatureName(signature),
      source: 'known',
    }),
  );
  await db
    .insert(methodSignatures)
    .values(selectorRows)
    .onConflictDoUpdate({
      target: methodSignatures.selector,
      set: {
        signature: sql`excluded.signature`,
        name: sql`excluded.name`,
        source: sql`excluded.source`,
      },
    });

  if (registry.tokens.length > 0) {
    // Ensure a token stub exists for every registry entry, then upsert the
    // registry row and flag the token as a stock token.
    await db
      .insert(tokens)
      .values(
        registry.tokens.map((t) => ({
          address: t.address.toLowerCase(),
          isStockToken: true,
        })),
      )
      .onConflictDoUpdate({
        target: tokens.address,
        set: { isStockToken: sql`true` },
      });
    await db
      .insert(stockTokens)
      .values(
        registry.tokens.map((t) => ({
          tokenAddress: t.address.toLowerCase(),
          ticker: t.ticker,
          companyName: t.companyName ?? null,
          issuerAddress: t.issuerAddress?.toLowerCase() ?? null,
          source: 'registry',
        })),
      )
      .onConflictDoUpdate({
        target: stockTokens.tokenAddress,
        set: {
          ticker: sql`excluded.ticker`,
          companyName: sql`excluded.company_name`,
          issuerAddress: sql`excluded.issuer_address`,
          source: sql`excluded.source`,
        },
      });
  }

  console.log(
    `Seeded ${labels.length} labels, ${selectorRows.length} selectors, ${registry.tokens.length} registry stock tokens.`,
  );
  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
