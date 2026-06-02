/**
 * Realtime schema bits owned by the gateway (F7/FEN-13):
 *   - the DELTA_CHANNEL payload parser, and
 *   - the presence key scheme.
 *
 * The channel payload format ("seq,x,y,color") is the contract published by
 * place.lua (see @canvas/redis-scripts). Presence keys are read/written only by
 * gateway instances, so they live here rather than in the shared schema package.
 * Both can be promoted into @canvas/redis-scripts later if another service
 * (e.g. the Convex flush job) needs to share them.
 */

/** Prefix (and SCAN glob root) for per-instance presence keys. */
export const PRESENCE_KEY_PREFIX = "presence:inst:";

/** Per-instance presence key holding that instance's local viewer count. */
export function presenceInstanceKey(instanceId: string): string {
  return `${PRESENCE_KEY_PREFIX}${instanceId}`;
}

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
