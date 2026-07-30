# Durable-journal retention & compaction

> Backbone hygiene contract — chantier **A8** ([FEN-651](/FEN/issues/FEN-651)),
> proposition-refonte §3.2 criterion **C6**. Owner: Founding Engineer.
> Related: [ADR-0003](../adr/0003-ws-gateway-topology.md) (the two-sink hot path),
> [ADR-0006](../adr/0006-snapshot-format.md) (snapshot format),
> [persistence-worker.md](./persistence-worker.md) (the drain seam).

The durable journal has **two** stores that would otherwise grow without bound.
This contract fixes the retention policy for each and where it is enforced.

```
place.lua ──XADD──▶ canvas:{slug}:stream ──drain──▶ Convex placements   (per-pixel history)
   │                       (Redis buffer)              Convex snapshots   (full-canvas blobs)
   └──SETRANGE──▶ canvas pixels string (live state — never the journal)
```

## 1. Redis placement stream — `canvas:{slug}:stream`

The stream is a **buffer** between the atomic hot path and the durable store, not
the durable store itself. Two complementary mechanisms bound it:

### 1a. Exact post-flush trim (steady state) — already in place

After the persistence worker flushes a batch to Convex, it advances its resume
cursor and trims the drained tail:

    XTRIM canvas:{slug}:stream MINID <lastFlushedStreamId>

(`apps/worker/src/redis.ts` `trimStream`, called from `drain.ts` **only after** the
Convex flush is confirmed — at-least-once: an entry is trimmed only once it is
durably in `placements`). In steady state the stream holds just the **undrained
tail**, so its size tracks worker lag, not total writes.

### 1b. Approximate MAXLEN backstop (worker-down safety) — added in A8

`place.lua`'s `XADD` takes an optional `streamMaxLen` (ARGV[16]); the gateway sets
it from `STREAM_MAXLEN` (default **1 000 000**, `0` disables):

    XADD canvas:{slug}:stream MAXLEN ~ <streamMaxLen> * x .. y .. color .. version .. userId .. ts

`~` (approximate) keeps the trim amortised-O(1) on the hot path. This is **only** a
memory backstop for when the worker is **down** and 1a stops running — without it the
firehose would grow the stream unboundedly until Redis OOMs.

**Durability trade-off (deliberate).** The MAXLEN cap can evict *undrained* entries
if the worker stays down past `streamMaxLen` writes. What that loses and does not:

- **Canvas state is never at risk.** The live image is the Redis pixels string
  (`SETRANGE`), captured independently by periodic snapshots (§2). A capped stream
  cannot corrupt or lose the picture.
- **What can be lost: per-pixel placement *history*/attribution** beyond the cap
  (the `placements` rows that feed moderation "what was underneath" and points
  accrual) — only for writes that happened while the worker was down *and* were
  pushed past the cap before it recovered.

**Sizing.** Pick `STREAM_MAXLEN ≥ peak_write_rate × max_tolerable_worker_outage`.
At ~100 writes/s the 1 000 000 default buffers ≈ 2.7 h of total outage before any
history is dropped; each entry is ~120–160 B, so the cap also bounds stream memory
to ≈ 150 MB. Raise it on bigger NAS RAM; lower it on constrained hosts. Worker
liveness/lag is the real mitigation — the cap is the seatbelt, not the plan.

## 2. Convex snapshots — full-canvas blobs

`worker:recordSnapshot` writes one `bin-palette-v1` blob (ADR-0006) per snapshot
interval (`SNAPSHOT_INTERVAL_MS` / `SNAPSHOT_EVERY_N_VERSIONS`). Each blob is a
**full** canvas image, so older blobs are pure storage cost once a newer full
snapshot exists — the stream + `placements` cover the tail beyond the latest.

**Policy: keep the newest `SNAPSHOT_RETENTION` (= 5) snapshots per canvas.**
Compaction runs **inline in `recordSnapshot`** (`apps/convex/convex/worker.ts`):
after inserting the new row it deletes older rows *and* their storage blobs
(`ctx.storage.delete`) beyond the newest 5. Because it compacts on every insert,
the `snapshots` table never holds more than `SNAPSHOT_RETENTION + 1` rows per canvas.

We keep 5 (not 1) for restore robustness — if the newest blob is somehow
missing/corrupt, an older full snapshot is still a valid restore floor.

> **Not compacted: `placements`.** Per-pixel history is a product feature (moderation
> reverse-lookup F8, points/attribution) with its own lifecycle, not journal
> overhead. Any future `placements` retention is a separate product decision and is
> explicitly **out of scope** for A8.

## 3. Convex moderation stores — `pixelModeration` & `auditLog`

These two tables are append-only in production code (insert + patch, no
`ctx.db.delete`) and were absent from this contract prior to [FEN-1017](/FEN/issues/FEN-1017) (AP-08).
Both are moderation-ledger stores: `auditLog` records one row per moderator action;
`pixelModeration` stores one row per cell affected by an action (the cell-level
overlay detail, linked via `modActionId`).

### 3a. `auditLog` — lié au canvas parent (décision CEO FEN-1027)

**Policy: retained as long as the canvas exists; purged in cascade on canvas deletion (key: `canvasId`).**

`auditLog` is scoped by `canvasId` and holds PII-adjacent data (moderator id +
target id). Traçabilité de modération is only required while the moderated content
exists — when the canvas is deleted the audit trail for that canvas is deleted with
it. Volume is low (one row per moderator action), so no compaction is needed during
the canvas lifecycle.

**Sizing (dimensioned).** One row per moderator action. A ban_wipe or delete
produces one `auditLog` row (plus N `pixelModeration` rows; see §3b). At MVP scale
(single canvas, bounded mod team) the table grows in the hundreds to low thousands
of rows — well within cascade-delete bounds.

### 3b. `pixelModeration` — keep forever, dimensioned (option a)

**Policy: no compaction. Retain every row indefinitely at MVP scale.**

`pixelModeration` stores the cell-level overlay for every removed pixel:
`removedColor`, `removedVersion`, `underneathColor`, and `restored` state.
It is the restore substrate for F8/CA3 — without it `restore` cannot re-apply the
original colour to the correct cells or re-check the under-colour.

**Why option (a) and not option (b) (compact restored rows)?**
Rows where `restored === true` are _theoretically_ reconstructible from `placements`
+ `auditLog`. However:

- The reconstruction is a non-trivial join, not a simple read, and would need to
  be re-implemented if either table schema changes.
- `placements` has its own keep-all assumption (stated out-of-scope in §2); if that
  assumption is ever revised, compacted `pixelModeration` rows become silently
  unrecoverable, turning a storage optimisation into permanent data loss.
- At MVP scale the storage cost is acceptable without compaction (see sizing below).

**Option (b) future path.** Compacting `restored === true` rows older than the
oldest retained snapshot (the snapshot floor, `SNAPSHOT_RETENTION`th oldest) inline
in `moderation.ts` after a `restore` action becomes viable only once `placements`
retention is confirmed keep-all by a separate product decision. Until that decision
is made, option (b) MUST NOT be activated — the safety invariant is:
`pixelModeration` rows are only droppable when `placements` guarantees the same
history floor.

**Sizing (dimensioned).** N rows per action where N = cells affected
(`cellsAffected` in `auditLog`). A per-user ban wipe typically affects the fraction
of the canvas placed by that user; on a 1 000 × 1 000 canvas a prolific placer might
account for 1 000 – 50 000 cells (0.1 % – 5 %). At 200–350 B per row that is
200 KB – 17 MB per action. For a canvas with hundreds of ban actions over its
lifetime the table stays well under 1 GB at normal traffic. Monitoring alert
threshold: `pixelModeration` row count > 500 000 (≈ 100–175 MB) per canvas triggers
a re-evaluation of whether option (b) should be activated.

## Traceability (→ C6)

| Mechanism | Where | Status |
|---|---|---|
| Stream exact trim (MINID, post-flush) | `worker/src/redis.ts`, `drain.ts` | pre-existing |
| Stream MAXLEN backstop | `place.lua` ARGV[16], gateway `STREAM_MAXLEN` | **A8** |
| Snapshot compaction (keep newest 5) | `convex/worker.ts` `recordSnapshot` | **A8** |
| `auditLog` lié au canvas parent (cascade-delete, décision CEO [FEN-1027](/FEN/issues/FEN-1027)) | no code needed — policy decision | **AP-08** |
| `pixelModeration` keep-forever (option a) | no code needed — policy decision | **AP-08** |
