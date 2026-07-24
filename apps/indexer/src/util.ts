export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Inclusive ascending range [from, to]. */
export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Inclusive descending range [hi, lo]. */
export function rangeDesc(hi: number, lo: number): number[] {
  const out: number[] = [];
  for (let n = hi; n >= lo; n--) out.push(n);
  return out;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const hexToNum = (h: string): number => Number(BigInt(h));

export const toHex = (n: number): string => `0x${n.toString(16)}`;
