import type {
  BlockSummary,
  TokenInfo,
  TokenTransferView,
  TxSummary,
} from '@4663scan/shared/api-types';
import type {
  BlockRow,
  StockTokenRow,
  TokenRow,
  TokenTransferRow,
  TxRow,
} from '@4663scan/shared/db/schema';
import type { Decode } from './services/decode.js';
import type { Meta } from './services/labels.js';

export function computeFee(
  gasUsed: number | null,
  effectiveGasPrice: string | null,
): string | null {
  if (gasUsed == null || effectiveGasPrice == null) return null;
  return (BigInt(gasUsed) * BigInt(effectiveGasPrice)).toString();
}

export function toBlockSummary(row: BlockRow): BlockSummary {
  return {
    number: row.number,
    hash: row.hash,
    timestamp: row.timestamp,
    txCount: row.txCount,
    gasUsed: row.gasUsed,
    gasLimit: row.gasLimit,
    baseFeePerGas: row.baseFeePerGas,
    // Slim rows dropped miner; the wire shape stays a string ('' = unknown).
    // Detail views never see this: hydration restores the real value there.
    miner: row.miner ?? '',
  };
}

export function toTokenInfo(
  row: TokenRow,
  stock: StockTokenRow | null,
  transferCount: number | null,
  holderCount: number | null = null,
): TokenInfo {
  return {
    address: row.address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    type: row.type,
    isStockToken: row.isStockToken,
    stock: stock
      ? {
          ticker: stock.ticker,
          companyName: stock.companyName,
          issuerAddress: stock.issuerAddress,
          source: stock.source,
          logoPath: stock.logoPath,
          logoFetchedAt: stock.logoFetchedAt ? Math.floor(stock.logoFetchedAt.getTime() / 1000) : null,
          assetClass: stock.assetClass,
          chainlinkFeed: stock.chainlinkFeed,
        }
      : null,
    totalSupply: row.totalSupply,
    firstSeenBlock: row.firstSeenBlock,
    transferCount,
    holderCount,
  };
}

export function makeViews(meta: Meta, decode: Decode) {
  async function toTxSummaries(rows: TxRow[]): Promise<TxSummary[]> {
    const addresses: string[] = [];
    const selectors: string[] = [];
    for (const r of rows) {
      addresses.push(r.from);
      if (r.to) addresses.push(r.to);
      if (r.methodId) selectors.push(r.methodId);
    }
    const [labels, names] = await Promise.all([
      meta.resolveLabels(addresses),
      decode.resolveMethodNames(selectors),
    ]);
    return rows.map((r) => ({
      hash: r.hash,
      blockNumber: r.blockNumber,
      txIndex: r.txIndex,
      timestamp: r.timestamp,
      from: { address: r.from, label: labels.get(r.from) ?? null },
      to: r.to ? { address: r.to, label: labels.get(r.to) ?? null } : null,
      contractAddress: r.contractAddress,
      value: r.value,
      status: r.status,
      methodId: r.methodId,
      methodName: r.methodId ? (names.get(r.methodId) ?? null) : null,
      fee: computeFee(r.gasUsed, r.effectiveGasPrice),
    }));
  }

  async function toTransferViews(
    rows: TokenTransferRow[],
  ): Promise<TokenTransferView[]> {
    const addresses: string[] = [];
    const tokenAddresses: string[] = [];
    for (const r of rows) {
      addresses.push(r.from, r.to);
      tokenAddresses.push(r.tokenAddress);
    }
    const [labels, refs] = await Promise.all([
      meta.resolveLabels(addresses),
      meta.resolveTokenRefs(tokenAddresses),
    ]);
    return rows.map((r) => ({
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      timestamp: r.timestamp,
      token: refs.get(r.tokenAddress) ?? {
        address: r.tokenAddress,
        name: null,
        symbol: null,
        decimals: null,
        isStockToken: false,
      },
      from: { address: r.from, label: labels.get(r.from) ?? null },
      to: { address: r.to, label: labels.get(r.to) ?? null },
      value: r.value,
    }));
  }

  return { toBlockSummary, toTokenInfo, toTxSummaries, toTransferViews };
}

export type Views = ReturnType<typeof makeViews>;
