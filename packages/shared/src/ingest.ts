import type {
  BlockInsert,
  LogInsert,
  TokenTransferInsert,
  TxInsert,
} from './db/schema.js';
import { TRANSFER_EVENT_TOPIC } from './abi/index.js';

/**
 * Raw JSON-RPC shapes (hex-string quantities), as returned by
 * eth_getBlockByNumber(_, true) and eth_getBlockReceipts. We deliberately
 * consume raw responses instead of viem-formatted ones so Arbitrum-specific
 * fields (l1BlockNumber, gasUsedForL1, tx types 0x64+) survive untouched.
 */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

export interface RawTx {
  hash: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: string;
  from: string;
  to: string | null;
  value: string;
  nonce: string;
  type: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
}

export interface RawReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockNumber: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  gasUsedForL1?: string;
  contractAddress: string | null;
  logs: RawLog[];
}

export interface RawBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas?: string | null;
  miner: string;
  size?: string;
  l1BlockNumber?: string;
  transactions: RawTx[];
}

export interface IngestRows {
  block: BlockInsert;
  txs: TxInsert[];
  logs: LogInsert[];
  transfers: TokenTransferInsert[];
  /** Distinct lowercased ERC-20 contract addresses seen in this block. */
  tokenAddresses: string[];
}

const hexToNum = (h: string | null | undefined): number | null =>
  h == null ? null : Number(BigInt(h));
const hexToNumStrict = (h: string): number => Number(BigInt(h));
const hexToDec = (h: string | null | undefined): string | null =>
  h == null ? null : BigInt(h).toString();
const hexToDecStrict = (h: string): string => BigInt(h).toString();
const lower = (s: string): string => s.toLowerCase();

/** Extracts the 20-byte address from a 32-byte topic. */
export function topicToAddress(topic: string): string {
  return ('0x' + topic.slice(-40)).toLowerCase();
}

/**
 * Pure mapping from one raw block + its receipts to insertable row sets.
 * Used by both the hot path (indexer) and the cold path (API lazy fetch) so
 * the two can never drift.
 */
export function blockToRows(block: RawBlock, receipts: RawReceipt[]): IngestRows {
  const blockNumber = hexToNumStrict(block.number);
  const timestamp = hexToNumStrict(block.timestamp);

  const blockRow: BlockInsert = {
    number: blockNumber,
    hash: lower(block.hash),
    parentHash: lower(block.parentHash),
    timestamp,
    txCount: block.transactions.length,
    gasUsed: hexToNumStrict(block.gasUsed),
    gasLimit: hexToNumStrict(block.gasLimit),
    baseFeePerGas: hexToDec(block.baseFeePerGas),
    miner: lower(block.miner),
    size: hexToNum(block.size),
    l1BlockNumber: hexToNum(block.l1BlockNumber),
  };

  const receiptByHash = new Map<string, RawReceipt>();
  for (const r of receipts) receiptByHash.set(lower(r.transactionHash), r);

  const txs: TxInsert[] = block.transactions.map((tx) => {
    const receipt = receiptByHash.get(lower(tx.hash));
    const input = tx.input ?? '0x';
    return {
      hash: lower(tx.hash),
      blockNumber,
      blockHash: lower(tx.blockHash),
      txIndex: hexToNumStrict(tx.transactionIndex),
      timestamp,
      from: lower(tx.from),
      to: tx.to ? lower(tx.to) : null,
      value: hexToDecStrict(tx.value),
      nonce: hexToNumStrict(tx.nonce),
      type: hexToNumStrict(tx.type),
      gas: hexToDecStrict(tx.gas),
      gasPrice: hexToDec(tx.gasPrice),
      maxFeePerGas: hexToDec(tx.maxFeePerGas),
      maxPriorityFeePerGas: hexToDec(tx.maxPriorityFeePerGas),
      methodId: input.length >= 10 ? input.slice(0, 10).toLowerCase() : null,
      input,
      status: receipt ? hexToNum(receipt.status) : null,
      gasUsed: receipt ? hexToNum(receipt.gasUsed) : null,
      effectiveGasPrice: receipt ? hexToDec(receipt.effectiveGasPrice) : null,
      gasUsedForL1: receipt ? hexToNum(receipt.gasUsedForL1) : null,
      contractAddress: receipt?.contractAddress
        ? lower(receipt.contractAddress)
        : null,
    };
  });

  const logRows: LogInsert[] = [];
  const transfers: TokenTransferInsert[] = [];
  const tokenAddresses = new Set<string>();

  for (const receipt of receipts) {
    for (const log of receipt.logs) {
      if (log.removed) continue;
      const logIndex = hexToNumStrict(log.logIndex);
      logRows.push({
        blockNumber,
        logIndex,
        txHash: lower(log.transactionHash),
        txIndex: hexToNumStrict(log.transactionIndex),
        address: lower(log.address),
        topic0: log.topics[0]?.toLowerCase() ?? null,
        topic1: log.topics[1]?.toLowerCase() ?? null,
        topic2: log.topics[2]?.toLowerCase() ?? null,
        topic3: log.topics[3]?.toLowerCase() ?? null,
        data: log.data,
      });

      // ERC-20 Transfer: Transfer(address,address,uint256) with exactly
      // 3 topics (ERC-721 uses 4 — indexed tokenId) and the value in data.
      if (
        log.topics.length === 3 &&
        log.topics[0]?.toLowerCase() === TRANSFER_EVENT_TOPIC &&
        log.data.length >= 66
      ) {
        const token = lower(log.address);
        tokenAddresses.add(token);
        transfers.push({
          blockNumber,
          logIndex,
          txHash: lower(log.transactionHash),
          timestamp,
          tokenAddress: token,
          from: topicToAddress(log.topics[1]!),
          to: topicToAddress(log.topics[2]!),
          value: hexToDecStrict(log.data.slice(0, 66)),
        });
      }
    }
  }

  return {
    block: blockRow,
    txs,
    logs: logRows,
    transfers,
    tokenAddresses: [...tokenAddresses],
  };
}
