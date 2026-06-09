/**
 * Shared cached-EVALSHA discipline for the gateway's hot-path Lua runners.
 *
 * Every Redis-backed script seam (place / moderate / grant / peek) needs the
 * same thing: SCRIPT LOAD once, run via EVALSHA shipping only the SHA + args,
 * and — if the script cache was flushed or we failed over (`NOSCRIPT`) — reload
 * once and retry. That logic was copy-pasted into four runners, each casting the
 * ioredis client with `as unknown as { script, evalsha }` to reach the loosely
 * typed surface. This module owns the logic and the cast in one place.
 */
import type Redis from "ioredis";

/**
 * The minimal ioredis surface a cached-EVALSHA runner needs. ioredis types
 * `script`/`evalsha` very loosely (overloaded, `unknown` reply), so we narrow to
 * exactly what we call — once, here — instead of casting at every call site.
 */
export interface EvalCapableRedis {
  script(sub: "LOAD", lua: string): Promise<string>;
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** A loaded-once script ready to run via EVALSHA with NOSCRIPT recovery. */
export interface CachedScript {
  /**
   * Run the script with the given KEYS + ARGV. The key COUNT is `keys.length`
   * per call (our scripts have variable KEYS arity), and all args are coerced to
   * strings as the Redis protocol requires.
   */
  run(keys: readonly string[], argv: readonly string[]): Promise<unknown>;
}

/**
 * Build a runner that loads `lua` once (SCRIPT LOAD) and runs it via EVALSHA,
 * reloading + retrying once on NOSCRIPT. `cmd` is any ioredis client; the single
 * cast to {@link EvalCapableRedis} lives here so callers stay type-clean.
 */
export function evalShaCached(cmd: Redis, lua: string): CachedScript {
  const redis = cmd as unknown as EvalCapableRedis;
  let sha: string | undefined;
  return {
    async run(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
      const args = [...keys, ...argv].map(String);
      if (sha === undefined) sha = await redis.script("LOAD", lua);
      try {
        return await redis.evalsha(sha, keys.length, ...args);
      } catch (err) {
        if (!/NOSCRIPT/.test((err as Error).message)) throw err;
        // Script cache flushed (or we failed over) — reload once and retry.
        sha = await redis.script("LOAD", lua);
        return redis.evalsha(sha, keys.length, ...args);
      }
    },
  };
}
