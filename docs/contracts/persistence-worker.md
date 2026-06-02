# Contract — persistence-worker durable layer (Convex)

Status: durable Convex layer **landed** (FEN-47). Worker *binary* wiring blocked on
the Redis hot-path reconciliation — see "Open prerequisite" below.

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

## Open prerequisite — Redis hot-path reconciliation (blocks the worker binary)

The durable Convex layer above is complete and testable. The worker **binary**
cannot yet run end-to-end against the canonical gateway because the two lineages
also diverged on the Redis hot-path schema:

- Canonical hot path (`packages/redis-scripts`, `apps/gateway`) writes a single
  `canvas:bitmap`, a `canvas:writes:count` counter, and publishes ephemeral
  `canvas:deltas` (`seq,x,y,color` — **no `userId`, no `ts`, not durable**).
- The worker drains a per-canvas **stream** `canvas:{id}:stream` with full
  `{x,y,color,version,userId,ts}` records, plus `canvas:{id}:meta` (version) and
  `canvas:{id}:pixels`.

Until `place.lua` + the gateway emit that durable placement stream (and agree on
per-canvas keys), `applyFlush` / snapshot / restore have nothing to consume. This
is a hot-path contract decision (R1/R2, Founding-Engineer-owned) tracked as a
follow-up child of FEN-47. The viewer-count path is unaffected — it reads the
shared `presence:inst:*` keys the canonical gateway already writes.

## Deployment requirement (ADR-0001)

`GATEWAY_CANVAS_ID` MUST equal the target canvas's F2 `slug`. The worker reads its
canvas id from the same value. Capture this in the Compose/`.env` once the worker
service is wired (DevOps), alongside `CONVEX_SELF_HOSTED_URL` and `REDIS_URL`.
