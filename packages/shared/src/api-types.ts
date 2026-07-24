/**
 * REST + SSE contract between apps/api and apps/web.
 *
 * Conventions:
 * - All wei / uint256 quantities are decimal strings.
 * - Timestamps are unix seconds (numbers).
 * - Addresses and hashes are 0x-prefixed lowercase (display checksumming is
 *   the web app's job).
 * - Every list endpoint returns Paginated<T> with an opaque cursor.
 *
 * Endpoints (all GET, prefix /v1):
 *   /status
 *   /blocks?limit&cursor                     → Paginated<BlockSummary>
 *   /blocks/:id            (number or hash)  → BlockDetail
 *   /blocks/:id/txs?limit&cursor             → Paginated<TxSummary>
 *   /txs?limit&cursor                        → Paginated<TxSummary>
 *   /txs/:hash                               → TxDetail
 *   /addresses/:address                      → AddressSummary
 *   /addresses/:address/txs?limit&cursor     → Paginated<TxSummary>
 *   /addresses/:address/transfers?limit&cursor → Paginated<TokenTransferView>
 *   /addresses/:address/tokens               → HoldingsResponse
 *   /addresses/:address/contract             → ContractInfo
 *   /addresses/:address/contract/read (POST) → ContractReadResult
 *   /addresses/:address/contract/events?limit&cursor → Paginated<ContractEventLog>
 *   /feed                                    → LiveFeed
 *   /tokens?q&stock&limit&cursor             → Paginated<TokenInfo>
 *   /tokens/:address                         → TokenInfo
 *   /tokens/:address/transfers?limit&cursor  → Paginated<TokenTransferView>
 *   /search?q                                → SearchResponse
 *   /stream                                  → SSE of StreamEvent
 *
 * Caching: responses for blocks/txs at depth ≥ CONFIRM_DEPTH carry
 * `Cache-Control: public, max-age=31536000, immutable`. Mutable responses
 * carry short TTLs. 404s are never cached long.
 */

export interface ChainStatus {
  chainId: number;
  /** Latest chain head seen via RPC (may be ahead of DB). */
  headBlock: number;
  /** Latest block fully ingested into the DB. */
  indexedBlock: number;
  indexedBlockTimestamp: number | null;
  /** First block of the head-first index run (backfill works below this). */
  indexStartBlock: number | null;
  backfill: {
    enabled: boolean;
    /** Next block the backfill will fetch (walks toward floor). */
    cursor: number | null;
    floor: number;
    done: boolean;
  };
  blocksIndexed: number;
  txsIndexed: number;
  /** Average block time in seconds over the recent window (float, ~0.1). */
  blockTimeSeconds: number | null;
  /** Latest base fee per gas, wei string. */
  baseFeePerGas: string | null;
  /** Storage tiering (optional so pre-tiering clients keep parsing). */
  tiering?: {
    /** Full detail is retained for this long; older rows are slim. */
    hotWindowSeconds: number;
    /** Non-stock transfers pruned through this block; null before a pass. */
    transfersPrunedThrough: number | null;
  };
}

export interface BlockSummary {
  number: number;
  hash: string;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  baseFeePerGas: string | null;
  miner: string;
}

export interface BlockDetail extends BlockSummary {
  parentHash: string;
  size: number | null;
  l1BlockNumber: number | null;
  /** Depth from head at response time. */
  confirmations: number;
}

export interface AddressRef {
  address: string;
  /** Human label when known (from address_labels or token metadata). */
  label: string | null;
}

export interface TxSummary {
  hash: string;
  blockNumber: number;
  txIndex: number;
  timestamp: number;
  from: AddressRef;
  to: AddressRef | null;
  /** Deployed contract address when to is null. */
  contractAddress: string | null;
  value: string;
  /** 1 success, 0 reverted, null unknown (no receipt). */
  status: number | null;
  methodId: string | null;
  /** Short human name for the method, e.g. 'transfer'; null if unresolved. */
  methodName: string | null;
  /** Total fee in wei (gasUsed * effectiveGasPrice), null if unknown. */
  fee: string | null;
}

export interface DecodedParam {
  name: string;
  type: string;
  /** Stringified value (addresses lowercased, uints as decimal strings). */
  value: string;
}

export interface DecodedMethod {
  selector: string;
  signature: string;
  name: string;
  source: 'known' | 'openchain';
  /** Present only when we hold a full ABI for the signature (e.g. ERC-20). */
  params: DecodedParam[] | null;
}

export interface TokenRef {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  isStockToken: boolean;
}

export interface TokenTransferView {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  token: TokenRef;
  from: AddressRef;
  to: AddressRef;
  value: string;
}

export interface LogView {
  logIndex: number;
  address: AddressRef;
  topics: string[];
  data: string;
}

export interface ContractSourceFile {
  path: string;
  content: string;
}

export interface ContractSource {
  verified: boolean;
  name: string | null;
  compilerVersion: string | null;
  /** Verifier-reported compiler settings (optimizer, evmVersion, …), opaque. */
  compilerSettings: unknown | null;
  /** Present only when verified. */
  abi: unknown[] | null;
  files: ContractSourceFile[] | null;
  provider: 'sourcify' | 'blockscout' | null;
}

export interface ContractProxyInfo {
  standard: 'eip1967' | 'eip1822';
  implementation: string | null;
  admin: string | null;
}

export interface DecodedSelectorInfo {
  selector: string;
  signature: string | null;
  name: string | null;
}

export interface ContractInfo {
  isContract: boolean;
  codeSize: number | null;
  /** Raw bytecode hex; present only when not verified (Code tab fallback). */
  bytecode: string | null;
  tokenType: 'erc20' | 'erc721' | null;
  token: TokenRef | null;
  proxy: ContractProxyInfo | null;
  /**
   * Cheaply derived from our own indexed transactions (contractAddress
   * match) — null when the deployment tx isn't in the indexed range, never
   * from an expensive on-chain scan.
   */
  creator: { address: string; txHash: string } | null;
  labels: { label: string; category: string }[];
  /**
   * Source of the IMPLEMENTATION when this is a proxy, source of the
   * address itself otherwise.
   */
  source: ContractSource;
  /**
   * PUSH4 selectors scanned from raw bytecode, cross-referenced against the
   * known/openchain method-signature cache — only populated when
   * source.verified is false (a verified ABI already gives full info).
   */
  decodedSelectors: DecodedSelectorInfo[] | null;
}

export interface ContractReadResult {
  success: boolean;
  /** Stringified outputs (bigints/addresses/bools as strings). */
  outputs: string[] | null;
  error: string | null;
}

export interface ContractEventLog {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  timestamp: number;
  topics: string[];
  data: string;
  decoded: { name: string; params: DecodedParam[] } | null;
}

export interface TxDetail {
  hash: string;
  blockNumber: number;
  blockHash: string;
  txIndex: number;
  timestamp: number;
  confirmations: number;
  from: AddressRef;
  to: AddressRef | null;
  contractAddress: string | null;
  value: string;
  nonce: number;
  type: number;
  status: number | null;
  gasLimit: string;
  gasUsed: number | null;
  gasUsedForL1: number | null;
  effectiveGasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  /** gasUsed * effectiveGasPrice, wei string. */
  fee: string | null;
  input: string;
  decoded: DecodedMethod | null;
  transfers: TokenTransferView[];
  logs: LogView[];
}

export interface StockInfo {
  ticker: string;
  companyName: string | null;
  issuerAddress: string | null;
  source: string;
  /** Self-hosted, normalized square webp path (e.g. '/token-logos/0x….webp')
   *  — never a third-party URL. Null = not fetched or unavailable upstream;
   *  the UI falls back to a generated monogram tile, never a broken image. */
  logoPath: string | null;
  /** Unix seconds the logo file was (re)written. The web app appends this
   *  as a ?v= cache-buster on the served path — logoPath's URL is otherwise
   *  stable per address, so a re-fetched logo (e.g. after this being wrong)
   *  needs a way to invalidate any edge/browser cache still holding the old
   *  bytes at that same path without needing a manual CDN purge. */
  logoFetchedAt: number | null;
  /** 'stock' | 'etf' | null — best-effort from company-name keywords, not a
   *  certified classification. */
  assetClass: string | null;
  /** Chainlink price-feed proxy address on this chain, matched by ticker
   *  against Chainlink's own published feed list. Null for tokens without
   *  one (most, currently) — shown only "if discoverable" per the charter. */
  chainlinkFeed: string | null;
}

export interface TokenInfo {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  type: string;
  isStockToken: boolean;
  stock: StockInfo | null;
  totalSupply: string | null;
  firstSeenBlock: number | null;
  /** Count of transfers indexed (approximate, from indexed range). */
  transferCount: number | null;
  /** Distinct addresses that have ever held a transfer of this token
   *  (address_token_seen) — an all-time "ever held" count, not a live
   *  current-holder count (that would need a live balance check per
   *  address, not cheap). Null only if the count itself failed. */
  holderCount: number | null;
}

export interface TokenHolding {
  token: TokenRef;
  /** Live balanceOf, raw units string. */
  balance: string;
}

export interface HoldingsResponse {
  items: TokenHolding[];
  /**
   * True when the live balance lookup failed or timed out — items is then
   * empty because balances are unknown, not because there are none.
   */
  degraded: boolean;
}

/**
 * Home page's "latest" panels, read straight from the current chain tip via
 * RPC — never from the DB, which on this chain's free RPC tier can trail
 * real time by a very large and growing margin (see docs/ops.md). blocks/txs
 * are ephemeral snapshots, not a gapless ledger: consecutive polls skip
 * whatever the chain produced in between at ~10 blocks/s.
 */
export interface LiveFeed {
  headBlock: number;
  /** Average block time in seconds across the returned block window. */
  blockTimeSeconds: number | null;
  /** Base fee of the newest returned block, wei string. */
  baseFeePerGas: string | null;
  blocks: BlockSummary[];
  txs: TxSummary[];
}

export interface AddressSummary {
  address: string;
  /** Live balance; null when the RPC was unavailable at response time. */
  balanceWei: string | null;
  isContract: boolean;
  labels: { label: string; category: string }[];
  /** Token metadata when this address is itself an ERC-20 contract. */
  token: TokenRef | null;
  /** Transactions involving this address within the indexed range. */
  indexedTxCount: number;
}

export type SearchResult =
  | { type: 'tx'; hash: string }
  | { type: 'block'; number: number; hash: string }
  | { type: 'address'; address: string; label: string | null }
  | {
      type: 'token';
      address: string;
      name: string | null;
      symbol: string | null;
      isStockToken: boolean;
    };

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface Paginated<T> {
  items: T[];
  /** Pass back as ?cursor= for the next page; null = end. */
  nextCursor: string | null;
}

/** SSE events on /v1/stream. Event name = `type` field. */
export type StreamEvent =
  | { type: 'block'; block: BlockSummary; txs: TxSummary[] }
  | { type: 'status'; status: ChainStatus };

export interface ApiError {
  error: string;
  statusCode: number;
}

/** GET /v1/payment-info — the going rate, shown before a submitter commits. */
export interface PaymentPublicInfo {
  configured: boolean;
  priceUsd: number;
  asset: string;
  assetAddress: string;
  assetDecimals: number;
  quoteWindowHours: number;
  maxTxAgeHours: number;
}

/** GET /v1/submissions/:id/payment?token= — one submission's frozen quote. */
export interface PaymentView {
  status: string;
  treasuryAddress: string;
  asset: string;
  assetAddress: string;
  priceQuotedUsd: string;
  amountRaw: string;
  amountDisplay: string;
  quoteExpiresAt: string;
  quoteExpired: boolean;
  paymentTxHash: string | null;
  paidAmountDisplay: string | null;
  paidAt: string | null;
}
