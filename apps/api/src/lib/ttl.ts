/** In-memory TTL map with insertion-order eviction once `cap` is reached. */
export class TtlMap<K, V> {
  private readonly map = new Map<K, { v: V; exp: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly cap: number,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    if (!this.map.has(key) && this.map.size >= this.cap) {
      let drop = Math.max(1, Math.ceil(this.cap / 10));
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.map.set(key, { v: value, exp: Date.now() + ttlMs });
  }
}

const inflight = new Map<string, Promise<unknown>>();

/** Single-flight: concurrent callers with the same key share one promise. */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

const memoStore = new Map<string, { v: unknown; exp: number }>();

/** TTL-memoized single-flight compute, for hot endpoints. */
export async function memo<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = memoStore.get(key);
  if (hit && hit.exp > Date.now()) return hit.v as T;
  const v = await dedupe(`memo:${key}`, fn);
  memoStore.set(key, { v, exp: Date.now() + ttlMs });
  if (memoStore.size > 1000) {
    const now = Date.now();
    for (const [k, e] of memoStore) if (e.exp <= now) memoStore.delete(k);
  }
  return v;
}
