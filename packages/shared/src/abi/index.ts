import { erc20Abi } from 'viem';

export { erc20Abi };

/** keccak256('Transfer(address,address,uint256)') */
export const TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** ERC-20 with bytes32 name/symbol (MKR-style), for metadata fallback. */
export const erc20Bytes32Abi = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * ERC-1967 standardized proxy storage slots (bytes32(uint256(keccak256(...))
 * - 1), per https://eips.ethereum.org/EIPS/eip-1967). Verified live against
 * a real deployed proxy on this chain (an ERC1967Proxy at
 * 0x55D8609ADf05205cef551C6b043BF385233fbCe7) — eth_getStorageAt at
 * ERC1967_IMPLEMENTATION_SLOT returned the correct, Sourcify-confirmed
 * implementation address, not a guess from memory.
 */
export const ERC1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const ERC1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const ERC1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** EIP-1822 (UUPS) storage slot: keccak256("PROXIABLE"). */
export const EIP1822_PROXIABLE_SLOT =
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';

/** ERC-165 interface ID for ERC-721 (probed via supportsInterface). */
export const ERC721_INTERFACE_ID = '0x80ac58cd';

export const erc165Abi = [
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** Minimal read surface used for identity detection, not a full ERC-721 ABI. */
export const erc721ProbeAbi = [
  ...erc165Abi,
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

/**
 * Seed map of well-known 4-byte selectors → signatures. The API augments this
 * with openchain.xyz lookups cached in the method_signatures table.
 */
export const KNOWN_SELECTORS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x40c10f19': 'mint(address,uint256)',
  '0x42966c68': 'burn(uint256)',
  '0x9dc29fac': 'burn(address,uint256)',
  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0x18160ddd': 'totalSupply()',
  '0xdd62ed3e': 'allowance(address,address)',
  '0x313ce567': 'decimals()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0xd505accf':
    'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  '0x7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '0x38ed1739':
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '0x18cbafe5':
    'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  '0x022c0d9f': 'swap(uint256,uint256,address,bytes)',
  '0x128acb08': 'swap(address,bool,int256,uint160,bytes)',
  '0x414bf389':
    'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  '0x04e45aaf':
    'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  '0xc04b8d59': 'exactInput((bytes,address,uint256,uint256,uint256))',
  '0x3593564c': 'execute(bytes,bytes[],uint256)',
  '0x24856bc3': 'execute(bytes,bytes[])',
  '0xac9650d8': 'multicall(bytes[])',
  '0x5ae401dc': 'multicall(uint256,bytes[])',
  '0x252dba42': 'aggregate((address,bytes)[])',
  '0x82ad56cb': 'aggregate3((address,bool,bytes)[])',
  '0x174dea71': 'aggregate3Value((address,bool,uint256,bytes)[])',
  '0x4faa8a26': 'depositETH()',
  '0x439370b1': 'depositEth()',
  '0x6e6e8a6a': 'submitRetryable(bytes32,uint256,uint256,uint256,uint256,uint64,uint256,address,address,address,bytes)',
  '0xeda1122c': 'redeem(bytes32)',
  '0x08635a95':
    'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
  '0x679b6ded':
    'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,uint256,bytes)',
  '0x25e16063': 'withdrawEth(address)',
  '0x0f4d14e9': 'depositEth(uint256)',
  '0xa1db9782': 'withdrawERC20(address,uint256)',
  '0x2e567b36': 'finalizeInboundTransfer(address,address,address,uint256,bytes)',
  '0x0c53c51c':
    'executeMetaTransaction(address,bytes,bytes32,bytes32,uint8)',
  '0x1cff79cd': 'execute(address,bytes)',
  '0xb6f9de95':
    'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
  '0x791ac947':
    'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  '0x5f575529': 'swap(string,address,uint256,bytes)',
};

/** Returns 'transfer' from 'transfer(address,uint256)'. */
export function signatureName(signature: string): string {
  const i = signature.indexOf('(');
  return i === -1 ? signature : signature.slice(0, i);
}
