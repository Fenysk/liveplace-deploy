/**
 * The real placement path (F5 / FEN-15) — the hook gateway.ts exposes as
 * `PlacementHandler`. It turns a client `place` message into one atomic
 * `place.lua` call and maps the result back to a protocol frame.
 *
 * Why this is the whole of F5's server side:
 *   - The gauge (token bucket, decision D1) lives entirely inside place.lua,
 *     which refills → checks → writes → consumes in a single Redis-atomic step
 *     (mitigation for R1: no client can race the cooldown). This handler does
 *     not re-implement that math — it only feeds the script the right inputs and
 *     translates its verdict.
 *   - The *effective* max is `canvas base + this user's F6 upgrade bonus`
 *     (FEN-27). We read it per call from `conn.gauge.effectiveGaugeMax`, so a
 *     bonus that was just raised lifts the ceiling on the very next placement
 *     (D1 CA3) — the bonus is never stored in Redis (F6 contract).
 *
 * The Lua arithmetic itself is covered by the redis-scripts gauge unit tests
 * (CA1–CA4) and `place.integration.test.ts` under a real `REDIS_URL`; this file
 * is covered by `test/placement.test.ts`, which drives the verdict→frame mapping
 * and asserts the effective max is the value passed to the script.
 */
import type Redis from "ioredis";
import {
  PLACE_LUA,
  placeArgs,
  parsePlaceResult,
  DELTA_CHANNEL,
  type GaugeParams,
  type PlaceResult,
} from "@canvas/redis-scripts";
import type { ClientMessage } from "@canvas/protocol";
import type { Connection, PlacementHandler } from "./gateway";

/** Injectable clock so the handler is deterministic under test; defaults to Date.now. */
export type Clock = () => number;

/**
 * Runs `place.lua` atomically. Abstracted behind an interface so the handler can
 * be unit-tested without a Redis server (the script's own behaviour is proven by
 * the redis-scripts tests). `keys`/`argv` come straight from `placeArgs`.
 */
export interface PlaceScriptRunner {
  run(keys: readonly string[], argv: readonly string[]): Promise<unknown>;
}

/**
 * ioredis-backed runner. Loads `place.lua` once (SCRIPT LOAD) and runs it via
 * EVALSHA on the hot path, reloading + retrying once on NOSCRIPT (a flushed
 * script cache or a failover) — so per placement we ship only the SHA + args,
 * not the whole script.
 *
 * The key COUNT is taken from `keys.length` per call rather than hard-coded:
 * `placeArgs` returns a variable number of KEYS (the bitmap/gauge/meta core plus
 * the frozen/stream/bans/op slots), so a fixed `numberOfKeys` would mis-split
 * keys from argv. Passing the real count to EVALSHA keeps the boundary correct
 * as the script's optional KEYS grow.
 */
export class IoredisPlaceRunner implements PlaceScriptRunner {
  private sha?: string;

  constructor(private readonly cmd: Redis) {}

  private get redis(): {
    script: (sub: "LOAD", lua: string) => Promise<string>;
    evalsha: (sha: string, numKeys: number, ...args: string[]) => Promise<unknown>;
  } {
    return this.cmd as unknown as {
      script: (sub: "LOAD", lua: string) => Promise<string>;
      evalsha: (sha: string, numKeys: number, ...args: string[]) => Promise<unknown>;
    };
  }

  async run(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
    const args = [...keys, ...argv].map(String);
    if (this.sha === undefined) this.sha = await this.redis.script("LOAD", PLACE_LUA);
    try {
      return await this.redis.evalsha(this.sha, keys.length, ...args);
    } catch (err) {
      if (!/NOSCRIPT/.test((err as Error).message)) throw err;
      // Script cache flushed (or we failed over) — reload once and retry.
      this.sha = await this.redis.script("LOAD", PLACE_LUA);
      return this.redis.evalsha(this.sha, keys.length, ...args);
    }
  }
}

/** Canvas-level inputs the handler needs to build a `place.lua` call. */
export interface PlacementConfig {
  width: number;
  height: number;
  paletteSize: number;
  /**
   * Canvas BASE gauge params (D1: refillIntervalMs, refillAmount, gaugeTtlMs and
   * the base `gaugeMax`). The base max here is replaced per call by the user's
   * effective max (base + F6 bonus); the rest pass through unchanged.
   */
  gauge: GaugeParams;
  /** Pub/sub channel place.lua fans the write out on; defaults to DELTA_CHANNEL. */
  deltaChannel?: string;
  /**
   * Canvas id this handler writes under (ADR-0003). MUST match the gateway's
   * served canvas so the pixel bitmap, the ban set (CA6) and the snapshot the
   * client read all share one namespace; omitted → DEFAULT_CANVAS_ID.
   */
  canvasId?: string;
  /**
   * TTL (ms) on a placement's idempotency claim (CA5). It only has to outlive a
   * client's resend window after a reconnect, not be permanent. Defaults to
   * DEFAULT_OP_TTL_MS.
   */
  opTtlMs?: number;
}

/** Default lifetime of an idempotency claim — comfortably covers a reconnect resend. */
export const DEFAULT_OP_TTL_MS = 60_000;

/**
 * The F5 placement handler. One client `place` → one atomic `place.lua` → one
 * protocol reply:
 *   - ok            → `ack` carrying the post-consume gauge state (current/max/countdown)
 *   - cooldown      → `cooldown { until }` (the gauge is empty; when the next charge lands)
 *   - out_of_bounds → `error { out_of_bounds }`
 *   - invalid_color → `error { invalid_color }`
 *   - frozen (F8.4) → `error { rate_limited }` ("frozen" is not in the frozen ws
 *                     ErrorCode contract; rate_limited is the closest "try later"
 *                     code — a dedicated code is the FE's protocol call, see FEN-19)
 *   - banned (CA6)  → `error { banned }`
 *
 * Idempotency (CA5): when the client tags a placement with a positive `seq`, the
 * script claims a per-op key so a resend (e.g. an optimistic client replaying an
 * un-acked placement after a reconnect) places exactly once.
 */
export class RedisPlacementHandler implements PlacementHandler {
  constructor(
    private readonly runner: PlaceScriptRunner,
    private readonly cfg: PlacementConfig,
    private readonly now: Clock = Date.now,
  ) {}

  async handlePlace(
    conn: Connection,
    msg: Extract<ClientMessage, { t: "place" }>,
  ): Promise<void> {
    const userId = conn.user.userId;
    // The transport already rejects anonymous sockets before reaching here; this
    // is a defensive guard so the script is never called without a real user key.
    if (userId === null) {
      conn.sendJson({
        t: "error",
        code: "unauthenticated",
        message: "sign in to place pixels",
        seq: msg.seq,
      });
      return;
    }

    // Effective max = canvas base + this user's resolved F6 bonus (FEN-27). Read
    // per call so a just-raised bonus lifts the ceiling immediately (D1 CA3).
    const gauge: GaugeParams = { ...this.cfg.gauge, gaugeMax: conn.gauge.effectiveGaugeMax };
    // Idempotency key (CA5): the client's `place.seq` correlation, used ONLY when
    // it is a stable positive integer. A naive client that omits it (or sends 0)
    // gets no dedup — every place is independent, exactly as before.
    const opId =
      typeof msg.seq === "number" && Number.isInteger(msg.seq) && msg.seq > 0
        ? String(msg.seq)
        : "";
    const { keys, argv } = placeArgs({
      x: msg.x,
      y: msg.y,
      width: this.cfg.width,
      height: this.cfg.height,
      color: msg.color,
      paletteSize: this.cfg.paletteSize,
      nowMs: this.now(),
      gauge,
      userId,
      canvasId: this.cfg.canvasId,
      deltaChannel: this.cfg.deltaChannel ?? DELTA_CHANNEL,
      opId,
      opTtlMs: this.cfg.opTtlMs ?? DEFAULT_OP_TTL_MS,
    });

    let result: PlaceResult;
    try {
      result = parsePlaceResult(await this.runner.run(keys, argv));
    } catch (err) {
      conn.sendJson({ t: "error", code: "internal", message: "placement failed", seq: msg.seq });
      console.warn(`[gateway] place script failed for ${userId}: ${(err as Error).message}`);
      return;
    }

    switch (result.status) {
      case "ok":
        // ack carries the gauge so the client can render current/max + countdown.
        conn.sendJson({
          t: "ack",
          seq: msg.seq ?? 0,
          charges: result.charges,
          max: result.max,
          cooldownUntil: result.cooldownUntil,
        });
        return;
      case "cooldown":
        conn.sendJson({ t: "cooldown", until: result.cooldownUntil });
        return;
      case "out_of_bounds":
        conn.sendJson({ t: "error", code: "out_of_bounds", message: "pixel out of bounds", seq: msg.seq });
        return;
      case "invalid_color":
        conn.sendJson({ t: "error", code: "invalid_color", message: "invalid palette colour", seq: msg.seq });
        return;
      case "frozen":
        conn.sendJson({
          t: "error",
          code: "rate_limited",
          message: "the canvas is frozen by a moderator",
          seq: msg.seq,
        });
        return;
      case "banned":
        // CA6: a banned viewer's placement is rejected server-side. `banned` is
        // a first-class ErrorCode in the frozen ws contract.
        conn.sendJson({
          t: "error",
          code: "banned",
          message: "you are banned from this canvas",
          seq: msg.seq,
        });
        return;
      default:
        conn.sendJson({ t: "error", code: "internal", message: "unknown placement result", seq: msg.seq });
    }
  }
}
