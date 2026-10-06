// Upstash Redis implementation of KvStore (server only). The Vercel
// Marketplace Upstash integration sets the REST URL/token env vars itself
// (see config.ts resolveRedis). Values are plain strings: automatic JSON
// (de)serialisation is switched off so locks and markers round-trip exactly.

import { Redis } from "@upstash/redis";
import type { RedisSettings } from "./config.ts";
import type { KvStore } from "./kv.ts";

const DEL_IF_EQUALS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * INCR + "set the TTL if the key has none", in ONE atomic call. Every call
 * heals a counter left without a TTL (e.g. by a function killed between two
 * separate calls), so a fixed-window brake can never stick forever.
 */
export const INCR_WITH_TTL = "local n = redis.call('incr', KEYS[1]) if redis.call('ttl', KEYS[1]) < 0 then redis.call('expire', KEYS[1], ARGV[1]) end return n";

/** The slice of the Upstash client this store uses (tests pass a fake). */
export type UpstashClient = Pick<Redis, "set" | "get" | "del" | "eval" | "zadd" | "zrange" | "zrem">;

export function createUpstashKv(settings: RedisSettings, client?: UpstashClient): KvStore {
  const redis: UpstashClient = client ?? new Redis({ url: settings.url, token: settings.token, automaticDeserialization: false });
  return {
    kind: "redis",
    async setNx(key, value, ttlSeconds) {
      return (await redis.set(key, value, { nx: true, ex: ttlSeconds })) === "OK";
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    async get(key) {
      const v = await redis.get<string>(key);
      return typeof v === "string" ? v : null;
    },
    async del(key) {
      await redis.del(key);
    },
    async delIfEquals(key, value) {
      return Number(await redis.eval(DEL_IF_EQUALS, [key], [value])) === 1;
    },
    async zadd(key, score, member) {
      await redis.zadd(key, { score, member });
    },
    async zrangeByScore(key, min, max, limit) {
      const out = await redis.zrange<string[]>(key, min, max, { byScore: true, offset: 0, count: limit });
      return out.map(String);
    },
    async zrem(key, member) {
      await redis.zrem(key, member);
    },
    async incr(key, ttlSeconds) {
      return Number(await redis.eval(INCR_WITH_TTL, [key], [String(ttlSeconds)]));
    },
  };
}
