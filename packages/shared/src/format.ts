/**
 * Isomorphic display helpers (safe in browser and node — no node imports).
 */
import { getAddress } from 'viem';

export function shortHash(hash: string, lead = 8, tail = 6): string {
  if (hash.length <= lead + tail + 2) return hash;
  return `${hash.slice(0, lead + 2)}…${hash.slice(-tail)}`;
}

export function shortAddress(address: string): string {
  return shortHash(address, 6, 4);
}

/** Checksums an address for display; returns input unchanged if invalid. */
export function checksum(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

/**
 * Formats a raw integer amount (wei-style string) with the given decimals.
 * Trims trailing zeros; uses significant digits for small values.
 */
export function formatUnitsTrim(
  raw: string | bigint,
  decimals: number,
  maxFrac = 6,
): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  if (value === 0n) return '0';
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, '0');
  if (whole === 0n) {
    // Small value: keep up to maxFrac significant digits.
    const firstSig = fracStr.search(/[1-9]/);
    const keep = Math.min(decimals, firstSig + maxFrac);
    fracStr = fracStr.slice(0, keep).replace(/0+$/, '');
    if (fracStr === '') return '0';
    return `${negative ? '-' : ''}0.${fracStr}`;
  }
  fracStr = fracStr.slice(0, maxFrac).replace(/0+$/, '');
  const wholeStr = groupThousands(whole.toString());
  return `${negative ? '-' : ''}${wholeStr}${fracStr ? '.' + fracStr : ''}`;
}

export function formatEth(wei: string | bigint, maxFrac = 6): string {
  return formatUnitsTrim(wei, 18, maxFrac);
}

export function formatGwei(wei: string | bigint, maxFrac = 4): string {
  return formatUnitsTrim(wei, 9, maxFrac);
}

export function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** '3s ago', '2m ago', '5h ago', '3d ago' */
export function timeAgo(unixSeconds: number, nowMs?: number): string {
  const now = nowMs ?? Date.now();
  let s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s ` : ''}ago`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m ? `${m}m ` : ''}ago`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h ? `${h}h ` : ''}ago`;
}

export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Arbitrum Orbit chains report an astronomically large nominal per-block
 * `gasLimit` from eth_getBlockByNumber (this chain: 2^50 =
 * 1,125,899,906,842,624) that accounts for L1 cost variability, not actual
 * execution capacity — dividing real gas usage by it rounds to "0.0%" for
 * every block, always, regardless of how full the block actually is. The
 * genuinely enforced per-block execution ceiling is Arbitrum's standard 32M
 * (same default as Arbitrum One); see
 * https://docs.arbitrum.io/launch-arbitrum-chain/configure-your-chain/common-configurations/gas-optimization-tools.
 * Callers computing a "how full is this block" percentage should pass this,
 * not the raw on-chain gasLimit field.
 */
export const EXECUTION_GAS_LIMIT = 32_000_000;

/** Percentage of gas used vs limit, one decimal. */
export function gasPercent(gasUsed: number, gasLimit: number): string {
  if (gasLimit === 0) return '0%';
  return `${((gasUsed / gasLimit) * 100).toFixed(1)}%`;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

export function isHexString(s: string, byteLength?: number): boolean {
  if (!HEX_RE.test(s)) return false;
  if (byteLength != null && s.length !== 2 + byteLength * 2) return false;
  return true;
}

export const isTxHash = (s: string): boolean => isHexString(s, 32);
export const isAddress = (s: string): boolean => isHexString(s, 20);
export const isBlockNumber = (s: string): boolean => /^\d+$/.test(s);
