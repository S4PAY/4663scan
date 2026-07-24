import { eq } from 'drizzle-orm';
import {
  stockTokens,
  tokens,
  type BlockInsert,
  type BlockRow,
  type TokenTransferInsert,
  type TxInsert,
  type TxRow,
} from './db/schema.js';
import type { Db } from './db/index.js';

/**
 * Storage tiers (see docs/architecture.md). Tier choice is per block, by
 * timestamp: blocks older than the hot window are written/demoted slim.
 * 'full' | 'slim' is a property of a stored row; writers take 'full' (head
 * follower — its catch-up range is always recent) or 'auto' (backfill and
 * the API cold persist path, which may handle blocks on either side of the
 * boundary).
 */
export type Tier = 'full' | 'slim';
export type WriteTierMode = 'full' | 'auto';

export function tierForTimestamp(
  blockTimestampSec: number,
  hotWindowSeconds: number,
  nowMs: number = Date.now(),
): Tier {
  return blockTimestampSec < Math.floor(nowMs / 1000) - hotWindowSeconds
    ? 'slim'
    : 'full';
}

/** Slim projection of a block row: detail columns NULLed, identity kept. */
export function slimBlockRow(b: BlockInsert): BlockInsert {
  return {
    ...b,
    parentHash: null,
    baseFeePerGas: null,
    miner: null,
    size: null,
    l1BlockNumber: null,
  };
}

/**
 * Slim projection of a tx row: calldata and gas detail NULLed; hash, block,
 * tx index, timestamp, from/to, value, method selector, status and contract
 * address survive so address history and lists work forever. NULL `input` is
 * the slim marker (empty calldata stores as 0-length bytes).
 */
export function slimTxRow(t: TxInsert): TxInsert {
  return {
    ...t,
    blockHash: null,
    nonce: null,
    type: null,
    gas: null,
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    input: null,
    gasUsed: null,
    effectiveGasPrice: null,
    gasUsedForL1: null,
  };
}

export function isSlimTx(row: Pick<TxRow, 'input'>): boolean {
  return row.input == null;
}

export function isSlimBlock(row: Pick<BlockRow, 'parentHash'>): boolean {
  return row.parentHash == null;
}

/**
 * Addresses whose transfers are never pruned: the stock_tokens registry plus
 * anything flagged is_stock_token (heuristic discoveries). Lowercase-hex keys.
 */
export async function loadStockAddressSet(db: Db): Promise<Set<string>> {
  const set = new Set<string>();
  const registry = await db
    .select({ address: stockTokens.tokenAddress })
    .from(stockTokens);
  for (const r of registry) set.add(r.address);
  const flagged = await db
    .select({ address: tokens.address })
    .from(tokens)
    .where(eq(tokens.isStockToken, true));
  for (const r of flagged) set.add(r.address);
  return set;
}

export function filterStockTransfers(
  transfers: TokenTransferInsert[],
  stockSet: ReadonlySet<string>,
): TokenTransferInsert[] {
  return transfers.filter((t) => stockSet.has(t.tokenAddress));
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Forever-tier (holder, token) pairs for address_token_seen, deduped within
 * the batch. Must be fed the *unfiltered* decoded transfers — slim blocks
 * drop non-stock transfer rows, but the pair sighting must survive or those
 * tokens vanish from holdings once retention passes. The zero address is
 * skipped: mint/burn counterparties are not holders. Sorted ascending per the
 * cross-writer convention (see the tokens upserts): concurrent transactions
 * acquire pair locks in a consistent order and cannot deadlock.
 */
export function addressTokenPairs(
  transfers: TokenTransferInsert[],
): { address: string; tokenAddress: string }[] {
  const seen = new Set<string>();
  const pairs: { address: string; tokenAddress: string }[] = [];
  for (const t of transfers) {
    for (const address of [t.from, t.to]) {
      if (address === ZERO_ADDRESS) continue;
      const key = `${address}_${t.tokenAddress}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ address, tokenAddress: t.tokenAddress });
    }
  }
  return pairs.sort((a, b) =>
    a.address < b.address
      ? -1
      : a.address > b.address
        ? 1
        : a.tokenAddress < b.tokenAddress
          ? -1
          : a.tokenAddress > b.tokenAddress
            ? 1
            : 0,
  );
}
