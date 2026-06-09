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
): Promise<RestoreResult> {
  if (await metaExists(redis, slug)) {
    return { restored: false, reason: "live_canvas_present" };
  }
  const latest = await convex.getLatestSnapshot(slug);
  if (!latest || !latest.url) {
    return { restored: false, reason: "no_durable_snapshot" };
  }

  const res = await fetch(latest.url);
  if (!res.ok) throw new Error(`snapshot download failed: ${res.status} ${res.statusText}`);
  const snap = decodeSnapshot(await res.arrayBuffer());

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

  const { pixels, version } = reconstructPixels(snap.pixels, width, height, latest.version, tail);
  const wrote = await writeRestoredCanvas(redis, slug, pixels, version);
  return wrote
    ? { restored: true, reason: "rebuilt_from_durable", version, replayed: tail.length }
    : { restored: false, reason: "canvas_revived_concurrently", version, replayed: tail.length };
}
