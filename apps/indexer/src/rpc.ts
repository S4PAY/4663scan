import type { PublicClient } from 'viem';
import type { RawBlock, RawReceipt } from '@4663scan/shared/ingest';
import type { Lane, RateLimiter } from './rate-limiter.js';
import { hexToNum, toHex } from './util.js';

export interface BlockBundle {
  block: RawBlock;
  receipts: RawReceipt[];
}

/** Thrown when the RPC node does not (yet) have the requested block. */
export class BlockUnavailableError extends Error {
  constructor(readonly blockNumber: number) {
    super(`block ${blockNumber} unavailable from RPC`);
    this.name = 'BlockUnavailableError';
  }
}

/**
 * viem's typed EIP-1193 schema does not cover eth_getBlockReceipts, and we
 * want RAW hex responses (Arbitrum fields survive untouched), so requests go
 * through a loosely typed view of client.request.
 */
type RawRequest = (args: { method: string; params?: unknown[] }) => Promise<unknown>;

/**
 * Raw JSON-RPC access. Every logical call acquires from the global limiter
 * first; the shared HTTP transport batches concurrent calls into few HTTP
 * requests.
 */
export class RpcClient {
  private readonly request: RawRequest;

  constructor(
    client: PublicClient,
    private readonly limiter: RateLimiter,
  ) {
    this.request = client.request as unknown as RawRequest;
  }

  async getLatestBlockNumber(lane: Lane): Promise<number> {
    await this.limiter.acquire(1, lane);
    const hex = (await this.request({ method: 'eth_blockNumber' })) as string;
    return hexToNum(hex);
  }

  async getBlockWithReceipts(n: number, lane: Lane): Promise<BlockBundle> {
    await this.limiter.acquire(2, lane);
    return this.fetchPair(n);
  }

  /** Fires all pairs concurrently AFTER acquiring 2×N tokens. */
  async getBlocksWithReceipts(numbers: number[], lane: Lane): Promise<BlockBundle[]> {
    if (numbers.length === 0) return [];
    await this.limiter.acquire(numbers.length * 2, lane);
    return Promise.all(numbers.map((n) => this.fetchPair(n)));
  }

  /** Lowercased hash of block n, or null when the node lacks it. */
  async getBlockHash(n: number, lane: Lane): Promise<string | null> {
    await this.limiter.acquire(1, lane);
    const block = (await this.request({
      method: 'eth_getBlockByNumber',
      params: [toHex(n), false],
    })) as { hash: string } | null;
    return block ? block.hash.toLowerCase() : null;
  }

  /** Raw eth_call; returns null on revert / node error. */
  async ethCall(to: string, data: string, lane: Lane): Promise<string | null> {
    await this.limiter.acquire(1, lane);
    try {
      return (await this.request({
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      })) as string;
    } catch {
      return null;
    }
  }

  private async fetchPair(n: number): Promise<BlockBundle> {
    const hex = toHex(n);
    const [block, receipts] = await Promise.all([
      this.request({
        method: 'eth_getBlockByNumber',
        params: [hex, true],
      }) as Promise<RawBlock | null>,
      this.request({
        method: 'eth_getBlockReceipts',
        params: [hex],
      }) as Promise<RawReceipt[] | null>,
    ]);
    if (block == null || receipts == null) throw new BlockUnavailableError(n);
    return { block, receipts };
  }
}
