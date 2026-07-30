/**
 * The moderation internal seam (F8 / FEN-19) — the gateway side of
 * docs/contracts/moderation-internal.md. Convex owns the decision + journal
 * (authz, derive the cells to write, ban/auditLog/overlay records); it then asks
 * the gateway to apply the Redis side-effects, because Convex never touches Redis
 * (guardrail G-A1). This module turns each authorised request into the matching
 * atomic Redis operation:
 *
 *   - moderate → one `moderate.lua` call: bulk overwrite + durable XADD per cell
 *     + coalesced fan-out (one bulkDelta, CA1). Echoes the bumped `version` so
 *     Convex can stamp `pixelModeration.overwriteVersion`.
 *   - ban      → SADD/SREM the per-canvas ban set `place.lua` SISMEMBERs, so a
 *     ban/unban (re)takes effect on the banned user's very next placement (CA6).
 *   - freeze   → SET/DEL the `canvas:frozen` flag `place.lua` checks before the
 *     gauge, so a freeze/unfreeze blocks/reopens placement instantly (CA4).
 *   - flush    → best-effort nudge to the persistence worker to drain the stream
 *     before a mass action (see ModerationService.requestFlush).
 *
 * The Redis surface is behind `ModerationRedis` so the service is unit-tested
 * without a server (the Lua behaviour itself is proven by the redis-scripts
 * integration tests), mirroring placement.ts's PlaceScriptRunner.
 */
import type Redis from "ioredis";
import {
  MODERATE_LUA,
  moderateArgs,
  parseModerateResult,
  canvasKeys,
  flushRequestChannel,
  type ModerationCell,
} from "@canvas/redis-scripts";
import { MODERATION_EVENT_CHANNEL, encodeModerationEvent } from "./schema";
import { evalShaCached, type CachedScript } from "./evalsha";

// `flushRequestChannel` is the shared per-canvas nudge channel, owned by
// @canvas/redis-scripts so the gateway publisher and the worker subscriber
// (FEN-71) agree on the name from one source. Re-exported here for the
// existing gateway callers/tests that import it from this module.
export { flushRequestChannel };

/** Thrown when a moderation request body is malformed → HTTP 400 (caller's fault). */
export class ModerationRequestError extends Error {}

/**
 * Validate + coerce the `cells` field of a `/internal/moderate` body into the
 * `ModerationCell[]` moderate.lua expects. Convex has already decided the
 * colours, but we never trust an external body blindly: each cell must be three
 * finite integers, else it is a 400 (not a partial/garbage Redis write).
 */
export function parseCells(raw: unknown): ModerationCell[] {
  if (!Array.isArray(raw)) throw new ModerationRequestError("cells must be an array");
  return raw.map((c, i) => {
    const cell = c as { x?: unknown; y?: unknown; color?: unknown };
    const x = cell.x, y = cell.y, color = cell.color;
    if (
      !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(color)
    ) {
      throw new ModerationRequestError(`cells[${i}] must have integer x,y,color`);
    }
    return { x: x as number, y: y as number, color: color as number };
  });
}

/** The Redis operations the moderation seam needs. Injectable for testing. */
export interface ModerationRedis {
  /** EVAL/EVALSHA moderate.lua; returns its raw [applied, lastSeq] reply. */
  evalModerate(keys: readonly string[], argv: readonly string[]): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  publish(channel: string, payload: string): Promise<unknown>;
}

/**
 * ioredis-backed `ModerationRedis`. Loads moderate.lua once (SCRIPT LOAD) and
 * runs it via EVALSHA, reloading + retrying once on NOSCRIPT — same hot-path
 * discipline as IoredisPlaceRunner. The key COUNT is `keys.length` per call
 * because moderateArgs returns a variable KEYS arity (the optional stream slot).
 */
export class IoredisModerationRedis implements ModerationRedis {
  private readonly script: CachedScript;

  constructor(private readonly cmd: Redis) {
    this.script = evalShaCached(cmd, MODERATE_LUA);
  }

  evalModerate(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
    return this.script.run(keys, argv);
  }

  set(key: string, value: string): Promise<unknown> {
    return this.cmd.set(key, value);
  }
  del(key: string): Promise<unknown> {
    return this.cmd.del(key);
  }
  sadd(key: string, member: string): Promise<unknown> {
    return this.cmd.sadd(key, member);
  }
  srem(key: string, member: string): Promise<unknown> {
    return this.cmd.srem(key, member);
  }
  publish(channel: string, payload: string): Promise<unknown> {
    return this.cmd.publish(channel, payload);
  }
}

export interface ModerationConfig {
  /** Canvas id (= slug, ADR-0003) whose per-canvas keys all ops address. */
  canvasId: string;
  width: number;
  height: number;
  paletteSize: number;
  /** Fan-out channel override; defaults to canvasDeltaChannel(canvasId). */
  deltaChannel?: string;
  /** Injectable clock (defaults to Date.now) so stream `ts` is deterministic in tests. */
  now?: () => number;
}

export interface ModerateOutcome {
  /** Cells actually written (applied < cells.length ⇒ a malformed batch from Convex). */
  applied: number;
  /** The bumped version of the last applied cell — echoed to Convex as `version`. */
  version: number;
}

export class ModerationService {
  private readonly now: () => number;

  constructor(
    private readonly redis: ModerationRedis,
    private readonly cfg: ModerationConfig,
  ) {
    this.now = cfg.now ?? Date.now;
  }

  /** F8.1/F8.2/F8.3 — apply a Convex-decided bulk overwrite atomically. */
  async moderate(cells: ReadonlyArray<ModerationCell>): Promise<ModerateOutcome> {
    const { keys, argv } = moderateArgs({
      width: this.cfg.width,
      height: this.cfg.height,
      paletteSize: this.cfg.paletteSize,
      canvasId: this.cfg.canvasId,
      cells,
      deltaChannel: this.cfg.deltaChannel,
      // The moderation HTTP seam carries no per-moderator id; the real actor is
      // recorded in the Convex auditLog. Stream records are stamped system ("").
      actorUserId: "",
      nowMs: this.now(),
    });
    const r = parseModerateResult(await this.redis.evalModerate(keys, argv));
    // Action-level fan-out (FEN-156): announce the bulk overwrite so every gateway
    // instance can push a `moderationEvent` frame to its viewers, giving the wipe
    // an attribution the per-pixel deltas lack. Only when something was actually
    // written — a 0-applied call (malformed batch from Convex) changed nothing, so
    // there is no event to surface. Best-effort: a publish hiccup must not fail the
    // moderation HTTP call (the durable record + deltas already landed).
    if (r.applied > 0) {
      try {
        await this.redis.publish(
          MODERATION_EVENT_CHANNEL,
          encodeModerationEvent({ canvasId: this.cfg.canvasId, version: r.lastSeq, cells: r.applied }),
        );
      } catch (err) {
        console.warn(`[gateway] moderation-event publish failed: ${(err as Error).message}`);
      }
    }
    return { applied: r.applied, version: r.lastSeq };
  }

  /** F8.4 — emergency freeze toggle (place.lua checks the flag before the gauge). */
  async setFrozen(frozen: boolean): Promise<void> {
    const key = canvasKeys(this.cfg.canvasId).frozen;
    if (frozen) await this.redis.set(key, "1");
    else await this.redis.del(key);
  }

  /** CA6 — (un)ban a user on the hot path; place.lua rejects a member's next place. */
  async setBan(userId: string, banned: boolean): Promise<void> {
    const key = canvasKeys(this.cfg.canvasId).bans;
    if (banned) await this.redis.sadd(key, userId);
    else await this.redis.srem(key, userId);
  }

  /**
   * Best-effort flush nudge before a mass action: publish a request the worker
   * drains on. It is BEST-EFFORT — the gateway cannot await the worker's drain
   * across processes — but correctness does not depend on it: moderate.lua now
   * streams overwrites durably and in version order (see Part A), so the worker
   * persists everything eventually regardless. Flush only narrows the freshness
   * window for Convex's derive-underneath. Returns true if the nudge was sent.
   */
  async requestFlush(): Promise<boolean> {
    await this.redis.publish(flushRequestChannel(this.cfg.canvasId), "1");
    return true;
  }
}
