# Contract — persistence-worker durable layer (Convex)

Status: durable Convex layer **landed** (FEN-47). Redis hot-path reconciliation
**landed** (FEN-54, ADR-0003) — the placement hot path now emits the durable
per-canvas stream the worker drains. Worker *binary* + Compose wiring is the
remaining child (see "Redis hot-path — the drain source" below).

The persistence worker (FEN-17) is the off-hot-path durable side of the system:
it drains the Redis placement stream to Convex in idempotent batches, periodically
snapshots the canvas, restores Redis from durable storage on cold start, and
flushes the F12 gallery discovery fields. Redis stays authoritative on the live
hot path (G-A1: no DB write during a placement); Convex is the durable mirror the
UI reads.

This doc is the seam between the worker and Convex. Per **ADR-0001** the worker
converged onto the F2 canonical `canvases` model; the retired string-keyed
`canvases` / `userCanvasStats` / `thumbnails` tables are gone.

## Identity bridge (ADR-0001)

The worker addresses a canvas by its WS `canvasId`, which is fixed **equal to the
F2 `slug`**, enforced operationally by `GATEWAY_CANVAS_ID`. Every durable function
resolves the F2 `id("canvases")` via the `canvases.by_slug` index. If no canvas
row matches the slug yet, every mutation is a **no-op** and every read returns
`null`/`[]` — `canvases:createCanvas` is the sole creator of canvas rows; the
worker never manufactures one.

## Durable side tables (`apps/convex/convex/schema.ts`)

All keyed to the F2 `id("canvases")`:

- `placements` — append log drained from the stream. Idempotent on
  `(canvasId, version)` (`by_canvas_version`), so at-least-once redelivery is
  exactly-once durable (R2). `version` is the global monotonic write sequence.
- `snapshots` — periodic bin-palette-v1 blobs in Convex file storage (the durable
  canvas source of truth, ADR-0002). `by_canvas` → latest; `by_canvas_version`.
- `flushState` — per-canvas resume cursor (`lastStreamId`, `lastFlushedVersion`).

Gallery discovery fields (`lastActivityAt`, `viewerCount`, `thumbnailStorageId`,
`thumbnailVersion`) live **on the canvas row**, not in a separate table — see
`docs/contracts/gallery-read.md` and `canvases:setGalleryFields`.

## Functions (`apps/convex/convex/worker.ts`) — all public, slug-addressed

| Function | Kind | Purpose |
| --- | --- | --- |
| `worker:applyFlush` | mutation | Insert a drained batch (dup-skip on version), fold fresh placements into `userCanvasStats` via the shared CA1 accrual (`points.accruePlacementPoints`), advance `flushState`. Returns `{ canvasFound, maxVersion, inserted }`. |
| `worker:recordSnapshot` | mutation | Insert a snapshot row, stamp `canvases.lastSnapshotAt` (monotonic). |
| `worker:generateUploadUrl` | mutation | Short-lived Convex file-storage upload URL (snapshot/thumbnail blobs). |
| `worker:getCanvasDurable` | query | Durable geometry + status for restore. |
| `worker:getLatestSnapshot` | query | Latest snapshot + temporary blob download URL (cold-start seed). |
| `worker:getPlacementsSince` | query | Placement tail with `version > afterVersion`, ascending, for replay. |
| `worker:getFlushState` | query | Resume cursor; `null` if never flushed. |

Gallery writes use `canvases:setGalleryFields` (idempotent + monotonic;
`lastActivityAt` off the newest drained placement ts, `viewerCount` off the summed
`presence:inst:*` keys, thumbnail pointer off a snapshot render).

**CA1 single-sourcing:** `applyFlush` does not duplicate the points formula — it
calls `points.accruePlacementPoints`, the same helper behind the internal
`points:awardPlacementPoints`. Only freshly-inserted (non-dup) placements feed it,
so points/`pixelsPlaced` stay exactly-once aligned with the placement log.

## Redis hot-path — the drain source (FEN-54, ADR-0003)

The hot path now writes the per-canvas keys the worker drains. All keys derive
from the canvas id (= `GATEWAY_CANVAS_ID` = F2 `slug`) via `canvasKeys(id)` in
`@canvas/redis-scripts` — the single source of truth shared by producer and
consumer:

| Key | Type | Role |
| --- | --- | --- |
| `canvas:{id}:pixels` | string | 1 byte/pixel bitmap, row-major. Snapshot source. |
| `canvas:{id}:meta`   | string (INCR) | Monotonic version == delta seq == snapshot label == canvas head version. |
| `canvas:{id}:stream` | stream | **Durable placement log** the worker drains (below). |
| `canvas:{id}:frozen` | string | F8.4 emergency-freeze flag. |
| `canvas:deltas`      | pub/sub | Ephemeral realtime fan-out (`seq,x,y,color`); **not** drained. |
| `presence:inst:*`    | string | Per-instance viewer count (summed for `viewerCount`). |

**Stream record.** `place.lua` `XADD`s one entry per accepted placement, in the
same atomic critical section as the bitmap write + version INCR:

```
XADD canvas:{id}:stream * x <x> y <y> color <color> version <v> userId <uid> ts <ms>
```

- `version` is the INCRemented `meta` counter — identical to the value stamped on
  the realtime delta, so stream order == write order == resync order.
- The entry's auto-generated stream ID is the worker's resume cursor
  (`flushState.lastStreamId`); `version` is the idempotency key on
  `(canvasId, version)` for `applyFlush`.
- The record shape matches `applyFlush`'s `placements[]` element exactly. The
  worker should parse entries with `parseStreamRecord` (exported alongside
  `PlacementStreamRecord` + `STREAM_FIELDS` from `@canvas/redis-scripts`) rather
  than re-deriving field order.

**Trimming.** `place.lua` never trims (that would drop undrained durability). The
worker trims/XDELs the stream tail only after a confirmed Convex flush.

**Worker binary seam (remaining child).** The Convex target and the Redis source
both exist; the worker binary itself (`apps/worker`) + its Compose service are
the remaining work — tracked as a child of FEN-54. The binary: reads
`REDIS_URL` + `GATEWAY_CANVAS_ID` (= slug) + `CONVEX_SELF_HOSTED_URL`, drains
`canvas:{slug}:stream` from `flushState.lastStreamId`, and calls the
**slug-addressed** `worker:*` functions below (already shipped — args take
`slug`, not a string `canvasId`).

**Not durable yet:** moderation overwrites (`moderate.lua`) adopt the per-canvas
keys but do not XADD to the stream, so a wipe/restore applied between snapshots
is not replayed on restore. Tracked as a follow-up (ADR-0003 § Consequences).

## Deployment requirement (ADR-0001)

`GATEWAY_CANVAS_ID` MUST equal the target canvas's F2 `slug`. The worker reads its
canvas id from the same value. Capture this in the Compose/`.env` once the worker
service is wired (DevOps), alongside `CONVEX_SELF_HOSTED_URL` and `REDIS_URL`.
