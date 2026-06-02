/**
 * Periodic durable snapshots. The worker packs the live Redis bitmap into a
 * binary snapshot blob (the `OP_SNAPSHOT` frame format from `@canvas/protocol`,
 * carrying version + geometry + palette-index bytes) and records it via
 * `worker:recordSnapshot`. This is the durable canvas source of truth used by
 * cold-start restore.
 */
import type Redis from "ioredis";
import { encodeSnapshot } from "@canvas/protocol";
import { readCanvasSnapshot } from "./redis.js";
import type { ConvexDurable } from "./convex.js";

export interface SnapshotPolicy {
  intervalMs: number;
  everyNVersions: number;
}

export interface SnapshotState {
  lastVersion: number;
  lastAtMs: number;
}

/**
 * Pure policy: snapshot only when the canvas actually advanced past the last
 * durable snapshot AND either the time interval elapsed or enough versions
 * accrued. Returning false on no-change keeps idle canvases off the durable path
 * (no churn, no empty snapshots).
 */
export function shouldSnapshot(
  currentVersion: number,
  state: SnapshotState,
  policy: SnapshotPolicy,
  nowMs: number,
): boolean {
  if (currentVersion <= state.lastVersion) return false;
  const byTime = nowMs - state.lastAtMs >= policy.intervalMs;
  const byVersions = currentVersion - state.lastVersion >= policy.everyNVersions;
  return byTime || byVersions;
}

export interface SnapshotResult {
  /** Canvas version captured by this snapshot. */
  version: number;
  /** Encoded blob byte length (for logging / size). */
  bytes: number;
  /** The encoded `OP_SNAPSHOT` blob, reused to derive the gallery thumbnail. */
  blob: Uint8Array;
}

/**
 * Build a snapshot from the live Redis canvas and persist it durably. The
 * version is read atomically with the pixels (`readCanvasSnapshot`), so the
 * snapshot's declared version never exceeds the pixels it captured.
 */
export async function buildAndRecord(
  redis: Redis,
  convex: ConvexDurable,
  slug: string,
  width: number,
  height: number,
  nowMs: number,
): Promise<SnapshotResult> {
  const { seq, pixels } = await readCanvasSnapshot(redis, slug, width, height);
  const buf = new Uint8Array(encodeSnapshot(pixels, seq, width, height));
  await convex.recordSnapshot(slug, seq, buf, nowMs);
  return { version: seq, bytes: buf.byteLength, blob: buf };
}
