/**
 * Cold-start recovery (G-Q4 reprise). If Redis has lost the live canvas (its
 * `meta` counter is absent) but Convex holds a durable snapshot, rebuild the
 * Redis canvas from the latest snapshot + the replayed placement tail. When the
 * live canvas is present we do nothing — Redis is authoritative on the hot path.
 */
import type Redis from "ioredis";
import { decodeSnapshot, isInBounds, isValidColorIndex } from "@canvas/protocol";
import { metaExists, writeRestoredCanvas } from "./redis.js";
import type { ConvexDurable, PlacementRecord } from "./convex.js";

/**
 * Crop or pad a flat row-major pixel buffer from (fromW × fromH) to (toW × toH).
 * Cells within the overlapping rectangle are preserved at their correct positions;
 * cells outside the source bounds are zero-filled. Returns the input unchanged
 * when dimensions already match (FEN-1802).
 */
export function cropPadPixels(
  pixels: Uint8Array,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): Uint8Array {
  if (fromW === toW && fromH === toH) return pixels;
  const out = new Uint8Array(toW * toH); // zero-initialised
  const copyW = Math.min(fromW, toW);
  const copyH = Math.min(fromH, toH);
  for (let row = 0; row < copyH; row++) {
    const srcOff = row * fromW;
    const dstOff = row * toW;
    out.set(pixels.subarray(srcOff, srcOff + copyW), dstOff);
  }
  return out;
}

/**
 * Pure reconstruction: start from the snapshot buffer, replay placements with
 * version > snapshot version (ascending), and report the resulting head version.
 * Out-of-bounds / bad-color rows are skipped defensively. Deterministic and
 * Redis-free so the recovery path is unit-testable.
 */
export function reconstructPixels(
  base: Uint8Array,
  width: number,
  height: number,
  snapshotVersion: number,
  placements: readonly PlacementRecord[],
): { pixels: Uint8Array; version: number } {
  const pixels = new Uint8Array(width * height);
  pixels.set(base.subarray(0, Math.min(base.length, pixels.length)));
  let version = snapshotVersion;
  for (const p of placements) {
    if (p.version <= snapshotVersion) continue; // already baked into the snapshot
    if (!isInBounds(p.x, p.y, width, height) || !isValidColorIndex(p.color)) continue;
    pixels[p.y * width + p.x] = p.color;
    if (p.version > version) version = p.version;
  }
  return { pixels, version };
}

export interface RestoreResult {
  restored: boolean;
  reason: string;
  version?: number;
  replayed?: number;
}

export async function restoreIfNeeded(
  redis: Redis,
  convex: ConvexDurable,
  slug: string,
  width: number,
  height: number,
  pageSize = 5_000,
  /** Convex _id used as the Redis key namespace; defaults to slug (FEN-1613). */
  redisCanvasId?: string,
): Promise<RestoreResult> {
  const redisId = redisCanvasId ?? slug;
  if (await metaExists(redis, redisId)) {
    return { restored: false, reason: "live_canvas_present" };
  }
  const latest = await convex.getLatestSnapshot(slug);
  if (!latest || !latest.url) {
    return { restored: false, reason: "no_durable_snapshot" };
  }

  const res = await fetch(latest.url);
  if (!res.ok) throw new Error(`snapshot download failed: ${res.status} ${res.statusText}`);
  const snap = decodeSnapshot(await res.arrayBuffer());

  // If the snapshot was recorded at different dimensions than the current durable
  // dims (e.g. canvas was resized since the snapshot), crop/pad it to the current
  // layout before replaying placements.  A flat subarray copy would scramble row
  // offsets on a size change (FEN-1802/C-C).
  const basePixels =
    snap.width === width && snap.height === height
      ? snap.pixels
      : cropPadPixels(snap.pixels, snap.width, snap.height, width, height);

  // Page the placement tail strictly past the snapshot version.
  const tail: PlacementRecord[] = [];
  let cursor = latest.version;
  for (;;) {
    const rows = await convex.getPlacementsSince(slug, cursor, pageSize);
    if (rows.length === 0) break;
    for (const r of rows) {
      tail.push({ x: r.x, y: r.y, color: r.color, version: r.version, userId: r.userId, ts: r.ts });
      if (r.version > cursor) cursor = r.version;
    }
    if (rows.length < pageSize) break;
  }

  const { pixels, version } = reconstructPixels(basePixels, width, height, latest.version, tail);
  const wrote = await writeRestoredCanvas(redis, redisId, pixels, version);
  return wrote
    ? { restored: true, reason: "rebuilt_from_durable", version, replayed: tail.length }
    : { restored: false, reason: "canvas_revived_concurrently", version, replayed: tail.length };
}
