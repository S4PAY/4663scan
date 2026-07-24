import { customType } from 'drizzle-orm/pg-core';

/**
 * Strict 0x-hex → Buffer. Throws on odd length or non-hex characters so a
 * malformed value can never be silently truncated into a wrong key.
 */
export function hexToBuf(hex: string): Buffer {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error(`invalid hex value: ${hex.slice(0, 80)}`);
  }
  return Buffer.from(h, 'hex');
}

export function bufToHex(buf: Buffer | Uint8Array): string {
  return '0x' + (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('hex');
}

/**
 * bytea column that surfaces as a 0x-prefixed lowercase hex string, so all
 * app code — ingest mapping, cache keys, JSON responses — keeps the hex-string
 * convention while the wire/storage format is raw bytes (half the size of hex
 * text). Mixed-case input is canonicalized to lowercase by the round trip.
 *
 * Raw `sql` queries bypass this codec: bind Buffer params there (hexToBuf).
 * Note memcmp order on bytea equals lexicographic order on lowercase hex, so
 * app-level string sorts and SQL-level column sorts stay consistent.
 */
export const hexBytea = customType<{ data: string; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: string): Buffer {
    return hexToBuf(value);
  },
  fromDriver(value: Buffer): string {
    return bufToHex(value);
  },
});
