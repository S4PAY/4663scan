'use client';

import { useState } from 'react';

/** 4663 in hex — wallet_addEthereumChain requires chainId as a 0x-string. */
const CHAIN_ID_HEX = '0x1237';

const ROBINHOOD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // publicnode's endpoint specifically, not one of the RPC allocations the
  // indexer/api depend on in packages/shared/src/env.ts — this URL ships to
  // every visitor's wallet, so it must stay working and keyless on its own.
  rpcUrls: ['https://robinhood-rpc.publicnode.com'],
  blockExplorerUrls: ['https://4663scan.io'],
};

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

type Status = 'idle' | 'pending' | 'added' | 'rejected' | 'error' | 'no-wallet';

export function AddToWalletButton() {
  const [status, setStatus] = useState<Status>('idle');

  async function handleClick() {
    const provider = getProvider();
    if (!provider) {
      setStatus('no-wallet');
      return;
    }
    setStatus('pending');
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [ROBINHOOD_CHAIN_PARAMS],
      });
      setStatus('added');
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      setStatus(code === 4001 ? 'rejected' : 'error');
    }
  }

  const label =
    status === 'pending'
      ? 'Confirm in wallet…'
      : status === 'added'
        ? 'Added ✓'
        : status === 'no-wallet'
          ? 'No wallet found'
          : status === 'rejected'
            ? 'Rejected — try again'
            : status === 'error'
              ? 'Failed — try again'
              : 'Add to Wallet';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === 'pending'}
      className="navlink text-left disabled:opacity-60"
    >
      {label}
    </button>
  );
}
