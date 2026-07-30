/**
 * Realtime schema bits owned by the gateway (F7/FEN-13): the DELTA_CHANNEL
 * payload parser. The channel payload format ("seq,x,y,color") is the contract
 * published by place.lua (see @canvas/redis-scripts).
 *
 * The presence key scheme moved into @canvas/redis-scripts (audit 1b) since the
 * worker consumes the same keys the gateway produces; re-exported here so the
 * gateway's existing `../schema` imports/tests keep resolving from one source.
 */
export { PRESENCE_KEY_PREFIX, presenceInstanceKey } from "@canvas/redis-scripts";

/** A single fanned-out write, parsed from the DELTA_CHANNEL "seq,x,y,color" payload. */
export interface DeltaMessage {
  seq: number;
  x: number;
  y: number;
  color: number;
}

/**
 * Parse a "seq,x,y,color" pub/sub payload. Returns null on malformed input so
 * the subscriber can drop a bad frame instead of crashing.
 */
export function parseDeltaMessage(payload: string): DeltaMessage | null {
  const parts = payload.split(",");
  if (parts.length !== 4) return null;
  const seq = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  const color = Number(parts[3]);
  if (![seq, x, y, color].every(Number.isFinite)) return null;
  return { seq, x, y, color };
}

/**
 * Gateway-only pub/sub channel carrying ACTION-level moderation events (FEN-156).
 *
 * The per-pixel wipe deltas already fan out on DELTA_CHANNEL — but a viewer can't
 * tell those apart from ordinary placements, so a wipe repaints the fresco with no
 * explanation (the exact anxiety UX Lot I / FEN-121 fixes). This channel carries
 * ONE event per applied `/internal/moderate` so every gateway instance can push a
 * `moderationEvent` frame to its local viewers — the cross-instance fan-out the
 * DELTA path uses, mirrored, so a viewer on ANY instance gets the attribution
 * (publishing only to the instance that received the HTTP call would silently miss
 * everyone connected elsewhere). Both ends are the gateway (publish on moderate,
 * subscribe to rebroadcast), so — like the presence keys above — it lives here
 * rather than in the shared @canvas/redis-scripts: no Lua, worker or Convex touches it.
 *
 * Payload is JSON (not the delta CSV): one message per moderation action is rare,
 * so legibility + forward-extensibility beat the byte-tight CSV the per-pixel
 * hot path needs. `canvasId` lets a (future) multi-canvas deployment filter; for
 * the single-canvas MVP it always matches the instance's canvas.
 */
export const MODERATION_EVENT_CHANNEL = "canvas:moderation-events";

export interface ModerationEventMessage {
  canvasId: string;
  /** Last write seq of the action (monotonic per canvas); informational. */
  version: number;
  /** Number of cells the action overwrote; informational. */
  cells: number;
}

export function encodeModerationEvent(msg: ModerationEventMessage): string {
  return JSON.stringify(msg);
}

/** Parse a moderation-event payload; null on anything malformed (drop, don't crash). */
export function parseModerationEvent(payload: string): ModerationEventMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { canvasId, version, cells } = raw as Record<string, unknown>;
  if (typeof canvasId !== "string" || canvasId === "") return null;
  if (typeof version !== "number" || !Number.isFinite(version)) return null;
  if (typeof cells !== "number" || !Number.isFinite(cells)) return null;
  return { canvasId, version, cells };
}
