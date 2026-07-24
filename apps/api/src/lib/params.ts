import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { badRequest } from './errors.js';

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return 25;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) {
    throw badRequest('invalid limit');
  }
  const n = Number(raw);
  if (n < 1 || n > 100) throw badRequest('invalid limit');
  return n;
}

/** Cursor of the form "<blockNumber>_<secondary>" (txIndex or logIndex). */
export function parsePairCursor(raw: unknown): [number, number] | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('invalid cursor');
  const m = /^(\d{1,15})_(\d{1,9})$/.exec(raw);
  if (!m) throw badRequest('invalid cursor');
  return [Number(m[1]!), Number(m[2]!)];
}

/** Cursor of the form "<blockNumber>". */
export function parseNumberCursor(raw: unknown): number | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) {
    throw badRequest('invalid cursor');
  }
  return Number(raw);
}

/** Offset cursor for the bounded tokens list. */
export function parseOffsetCursor(raw: unknown): number {
  return parseNumberCursor(raw) ?? 0;
}

export function requireAddress(raw: string): string {
  const a = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw badRequest('invalid address');
  return a;
}

export function requireTxHash(raw: string): string {
  const h = raw.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw badRequest('invalid tx hash');
  return h;
}

/** Row-value comparison so composite (a, b) indexes drive keyset scans. */
export const rowLt = (a: AnyPgColumn, b: AnyPgColumn, cur: [number, number]): SQL =>
  sql`(${a}, ${b}) < (${cur[0]}, ${cur[1]})`;

export const rowGt = (a: AnyPgColumn, b: AnyPgColumn, cur: [number, number]): SQL =>
  sql`(${a}, ${b}) > (${cur[0]}, ${cur[1]})`;

export const asHex = (s: string): `0x${string}` => s as `0x${string}`;

/** Escapes ILIKE wildcards (backslash is Postgres's default escape char). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** Postgres text parameters cannot carry NUL bytes — reject with a 400. */
export function requireNulFree(s: string, name = 'q'): string {
  if (s.includes('\u0000')) throw badRequest(`invalid ${name}`);
  return s;
}
