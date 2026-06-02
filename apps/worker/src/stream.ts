/**
 * Pure assembly of a drain batch from raw Redis stream entries
 * (`canvas:{slug}:stream`, ADR-0003). Kept Redis-free so the at-least-once drain
 * path is unit-testable without live infra (G-Q4: reprise testée).
 *
 * Field order / shape is owned by `@canvas/redis-scripts` (`parseStreamRecord`,
 * `STREAM_FIELDS`) — the same module `place.lua` is documented against — so the
 * worker never re-derives it.
 */
import { parseStreamRecord } from "@canvas/redis-scripts";
import { toPlacementRecord, type PlacementRecord } from "./convex.js";

/** Raw ioredis stream entry: `[id, [field, value, field, value, ...]]`. */
export type RawEntry = [id: string, fields: string[]];

export interface ParsedBatch {
  /** Stream ids in delivery order. */
  ids: string[];
  /** Placements ready for `worker:applyFlush` (idempotent on canvasId+version). */
  placements: PlacementRecord[];
  /**
   * Highest stream id in the batch — the durable resume cursor. Advanced past
   * dropped poison ids too, so a malformed entry can never wedge the drain.
   */
  lastId: string | null;
}

/**
 * Turn raw stream entries into a drain batch. An entry that parses to a NaN
 * `version` (malformed / truncated) is dropped from the placements payload —
 * `version` is the idempotency + ordering key, so a NaN one is unusable — but
 * its id still advances `lastId` (no silent wedge). Drops are surfaced via
 * `onDrop` so the caller logs rather than silently truncating.
 */
export function assembleBatch(
  entries: RawEntry[],
  onDrop?: (id: string, reason: string) => void,
): ParsedBatch {
  const ids: string[] = [];
  const placements: PlacementRecord[] = [];
  for (const [id, fields] of entries) {
    ids.push(id);
    const rec = parseStreamRecord(fields);
    if (!Number.isFinite(rec.version)) {
      onDrop?.(id, "non-finite version");
      continue;
    }
    placements.push(toPlacementRecord(rec));
  }
  return { ids, placements, lastId: ids.length ? ids[ids.length - 1]! : null };
}
