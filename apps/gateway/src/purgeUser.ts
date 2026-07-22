/**
 * `POST /internal/purge-user` — the Redis side of account deletion (FEN-1966,
 * contract C-4 / §3c of the FEN-1917 plan). Convex owns the decision (the
 * authenticated user deleting THEIR OWN account) and the durable purge; it then
 * asks the gateway to erase every Redis key that references the user, because
 * Convex never touches Redis (guardrail G-A1). Same seam + auth envelope as
 * `/internal/moderate` (Bearer GATEWAY_INTERNAL_SECRET).
 *
 * Per member canvas (canvases the user placed/joined on — `canvasIds`):
 *   - DEL   `canvas:{id}:gauge:{userId}`      (live réserve/cooldown hash)
 *   - SCAN+DEL `canvas:{id}:op:{userId}:*`    (short-TTL idempotency keys)
 *   - SREM  `canvas:{id}:bans` userId         (hot-path ban set membership)
 *
 * Per owned canvas (the personal canvas cascade, §3d — `ownedCanvasIds`):
 *   - SCAN+DEL `canvas:{id}:*`                (pixels, meta, stream, frozen,
 *     bans, every gauge/op of every user — the canvas dies entirely)
 *
 * Attribution funnel (FEN-242, §3c):
 *   - HGET `attr:userref` userId → ref, SREM `attr:signups:{ref}` userId,
 *     HDEL `attr:userref` userId
 *
 * Everything is idempotent: DEL/SREM/HDEL on absent keys are no-ops, so a
 * re-run after a partial account-deletion crash converges to the same state.
 * The `canvas:{id}:stream` entries carrying the userId are NOT touched here —
 * Convex forceFlushes the concerned canvases first so the worker drains them
 * to the durable log, where the Convex purge anonymises them (C-4 step 2).
 */
import { canvasKeys, gaugeKey, canvasUserOpPattern, canvasNamespacePattern } from "@canvas/redis-scripts";
import { ModerationRequestError } from "./moderation";
import { USERREF_KEY, signupsKey } from "./attribution";

/** The narrow Redis surface the purge needs (ioredis satisfies it). */
export interface PurgeRedis {
  del(...keys: string[]): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<unknown>;
  scan(
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
}

export interface PurgeUserRequest {
  userId: string;
  /** Canvases the user participated on (per-user keys are removed). */
  canvasIds: string[];
  /** Canvases the user OWNS (every `canvas:{id}:*` key is removed). */
  ownedCanvasIds: string[];
}

export interface PurgeUserResult {
  keysDeleted: number;
  bansRemoved: number;
  attributionCleared: boolean;
}

/**
 * Validate + coerce a `/internal/purge-user` body. Malformed input is a 400
 * (ModerationRequestError), never a partial purge.
 */
export function parsePurgeUserBody(body: Record<string, unknown>): PurgeUserRequest {
  const userId = body.userId;
  if (typeof userId !== "string" || userId === "") {
    throw new ModerationRequestError("missing userId");
  }
  const readIds = (field: "canvasIds" | "ownedCanvasIds"): string[] => {
    const raw = body[field] ?? [];
    if (!Array.isArray(raw)) throw new ModerationRequestError(`${field} must be an array`);
    return raw.map((id, i) => {
      if (typeof id !== "string" || id === "") {
        throw new ModerationRequestError(`${field}[${i}] must be a non-empty string`);
      }
      return id;
    });
  };
  return { userId, canvasIds: readIds("canvasIds"), ownedCanvasIds: readIds("ownedCanvasIds") };
}

/** Upper bound on SCAN round-trips per pattern — a runaway-cursor backstop. */
const MAX_SCAN_ITERATIONS = 10_000;
/** DEL batch size (bounds a single command's key arity). */
const DEL_BATCH = 100;

export class PurgeUserService {
  constructor(private readonly redis: PurgeRedis) {}

  async purgeUser(req: PurgeUserRequest): Promise<PurgeUserResult> {
    let keysDeleted = 0;
    let bansRemoved = 0;

    // Member canvases: only the keys naming this user. The owned set is swept
    // wholesale below, so skip canvases present in both lists.
    const owned = new Set(req.ownedCanvasIds);
    for (const canvasId of req.canvasIds) {
      if (owned.has(canvasId)) continue;
      keysDeleted += await this.deleteKeys([gaugeKey(canvasId, req.userId)]);
      keysDeleted += await this.deleteByPattern(canvasUserOpPattern(canvasId, req.userId));
      const removed = await this.redis.srem(canvasKeys(canvasId).bans, req.userId);
      bansRemoved += typeof removed === "number" ? removed : 0;
    }

    // Owned canvases: the whole per-canvas namespace dies (§3d).
    for (const canvasId of req.ownedCanvasIds) {
      keysDeleted += await this.deleteByPattern(canvasNamespacePattern(canvasId));
    }

    // Attribution funnel: unpin the user from their signup ref (FEN-242 keys).
    const ref = await this.redis.hget(USERREF_KEY, req.userId);
    if (ref !== null) {
      await this.redis.srem(signupsKey(ref), req.userId);
      await this.redis.hdel(USERREF_KEY, req.userId);
    }

    return { keysDeleted, bansRemoved, attributionCleared: ref !== null };
  }

  private async deleteByPattern(pattern: string): Promise<number> {
    let deleted = 0;
    let cursor = "0";
    for (let i = 0; i < MAX_SCAN_ITERATIONS; i++) {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      deleted += await this.deleteKeys(keys);
      cursor = next;
      if (cursor === "0") break;
    }
    return deleted;
  }

  private async deleteKeys(keys: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += DEL_BATCH) {
      const batch = keys.slice(i, i + DEL_BATCH);
      if (batch.length === 0) continue;
      const n = await this.redis.del(...batch);
      deleted += typeof n === "number" ? n : 0;
    }
    return deleted;
  }
}
