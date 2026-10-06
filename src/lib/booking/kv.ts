// Minimal key-value store used for the fulfilment lock, idempotency markers
// and the index of open Cloudbeds holds. Production uses Upstash Redis
// (kvUpstash.ts); tests, stripe-mock and Stripe test mode without Redis use
// the in-memory store below (per process - refused in live mode).

export interface KvStore {
  readonly kind: "redis" | "memory";
  /** SET key value NX EX ttl. True when the key was set (did not exist). */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** SET key value EX ttl. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Deletes the key only while it still holds `value` (safe lock release). */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /** Sorted-set add (score = epoch ms). */
  zadd(key: string, score: number, member: string): Promise<void>;
  /** Members with min <= score <= max, lowest first, at most `limit`. */
  zrangeByScore(key: string, min: number, max: number, limit: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<void>;
  /** INCR; the TTL is set when the counter is created (fixed window). Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/** In-memory KvStore. Atomic within one process (JS is single-threaded between awaits). */
export function createMemoryKv(now: () => number = Date.now): KvStore & { size(): number } {
  const data = new Map<string, Entry>();
  const zsets = new Map<string, Map<string, number>>();
  const live = (key: string): Entry | null => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return e;
  };
  return {
    kind: "memory",
    async setNx(key, value, ttlSeconds) {
      if (live(key)) return false;
      data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async set(key, value, ttlSeconds) {
      data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async del(key) {
      data.delete(key);
    },
    async delIfEquals(key, value) {
      const e = live(key);
      if (!e || e.value !== value) return false;
      data.delete(key);
      return true;
    },
    async zadd(key, score, member) {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, score);
      zsets.set(key, z);
    },
    async zrangeByScore(key, min, max, limit) {
      const z = zsets.get(key);
      if (!z) return [];
      return [...z.entries()]
        .filter(([, s]) => s >= min && s <= max)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([m]) => m);
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
    },
    async incr(key, ttlSeconds) {
      const e = live(key);
      const n = (e ? Number(e.value) || 0 : 0) + 1;
      data.set(key, { value: String(n), expiresAt: e ? e.expiresAt : now() + ttlSeconds * 1000 });
      return n;
    },
    size() {
      return data.size;
    },
  };
}
