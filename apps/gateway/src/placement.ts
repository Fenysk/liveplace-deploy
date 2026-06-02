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
 * ioredis-backed runner. Registers `place.lua` as a custom command so ioredis
 * caches its SHA and uses EVALSHA on the hot path (falling back to EVAL on
 * NOSCRIPT automatically) — per placement we ship only the SHA + args, not the
 * whole script. `numberOfKeys` is the 4 KEYS place.lua expects: bitmap, gauge,
 * write counter, frozen flag.
 */
export class IoredisPlaceRunner implements PlaceScriptRunner {
  private static readonly COMMAND = "placePixel";

  constructor(private readonly cmd: Redis) {
    const c = this.cmd as unknown as {
      placePixel?: unknown;
      defineCommand: (name: string, def: { numberOfKeys: number; lua: string }) => void;
    };
    // Idempotent: defineCommand twice on one client would throw, so guard it.
    if (typeof c.placePixel !== "function") {
      c.defineCommand(IoredisPlaceRunner.COMMAND, { numberOfKeys: 4, lua: PLACE_LUA });
    }
  }

  run(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
    const c = this.cmd as unknown as {
      placePixel: (...args: string[]) => Promise<unknown>;
    };
    return c.placePixel(...keys, ...argv);
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
}

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
      deltaChannel: this.cfg.deltaChannel ?? DELTA_CHANNEL,
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
      default:
        conn.sendJson({ t: "error", code: "internal", message: "unknown placement result", seq: msg.seq });
    }
  }
}
