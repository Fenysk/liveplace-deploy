# @canvas/worker — persistence worker (R2 / FEN-57)

Standalone background service that owns the **durable** side of LivePlace. It is
**not on the hot path** (G-A1): a pixel placement only touches Redis (gateway +
`place.lua`); this worker moves that data to the durable Convex layer
out-of-band, and rebuilds Redis from Convex on cold start.

It is the binary that joins the two ends built earlier:

- **Redis source** — `place.lua` XADDs every accepted placement to
  `canvas:{slug}:stream` as `{x,y,color,version,userId,ts}` (FEN-54, ADR-0003).
- **Convex target** — the slug-addressed `worker:*` API (FEN-47). These functions
  are `internal*` (FEN-86): the worker reaches them only through the public,
  secret-guarded `worker:run` action (see Config → `GATEWAY_INTERNAL_SECRET`).
- **Contract** — [`docs/contracts/persistence-worker.md`](../../docs/contracts/persistence-worker.md)
  and [`docs/adr/0003-ws-gateway-topology.md`](../../docs/adr/0003-ws-gateway-topology.md)
  (the realtime backbone ADR — it records the per-canvas Redis stream + key schema).

## Responsibilities

1. **Drain** (`src/drain.ts`) — `XREAD canvas:{slug}:stream` strictly after the
   durable resume cursor → batch → `worker:applyFlush`. `applyFlush` is
   idempotent on `(canvasId, version)` and advances `flushState.lastStreamId`
   server-side, so the cursor is durable in Convex and a crash redelivers rather
   than loses or double-counts (**R2**, at-least-once → exactly-once durable).
   The stream tail is trimmed (`XTRIM MINID`) **only after** a confirmed flush;
   `place.lua` itself never trims.
2. **Snapshots** (`src/snapshot.ts`) — periodically pack the live Redis bitmap
   into a binary snapshot blob (`OP_SNAPSHOT` frame, `@canvas/protocol`) and
   record it via `worker:recordSnapshot` + `worker:generateUploadUrl`. Skipped
   when the canvas hasn't advanced (no churn on idle canvases).
3. **Cold-start restore** (`src/restore.ts`) — if Redis lost the live canvas
   (its `meta` counter is absent) but Convex holds a snapshot, rebuild Redis from
   the latest snapshot + the replayed placement tail (`worker:getPlacementsSince`).
   No-op when Redis already holds the canvas (Redis stays authoritative).

4. **Gallery activation** (FEN-33, F12) — off the hot path, the worker maintains
   the public-gallery discovery fields ON the F2 canvas row via
   `canvases:setGalleryFields` (idempotent + monotonic): `lastActivityAt` (newest
   drained placement ts, after each drain), `viewerCount` (summed `presence:inst:*`
   keys every `VIEWER_FLUSH_INTERVAL_MS`), and the thumbnail pointer
   (`thumbnailStorageId`/`thumbnailVersion`, rendered from each new snapshot blob,
   `src/thumbnail.ts`). All best-effort — a gallery-write failure never strands
   the durable drain/snapshot.

A best-effort Redis flush lock (`src/lock.ts`, `G-Perf4`) keeps two instances
from double-draining; correctness does not depend on it.

## Identity

The worker reads the same `GATEWAY_CANVAS_ID` as the gateway, so both point at the
same default canvas. Since FEN-1564/1613 the per-canvas Redis key namespace
(`canvasKeys(id)`) is the canvas Convex **`_id`**, not the human `slug` — so the
`canvas:{slug}:*` key templates above denote that id value. ADR-0001's original
"canvasId == slug" identity is historical; the worker's `cfg.slug` field keeps its
legacy name but carries the id, and multi-canvas draining threads an explicit
`(slug, redisCanvasId=_id)` pair rather than assuming the two are equal.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `CONVEX_SELF_HOSTED_URL` | `http://localhost:3210` | Self-hosted Convex backend (calls the `worker:run` action) |
| `GATEWAY_INTERNAL_SECRET` | _(unset)_ | Shared secret authenticating the worker to the `worker:run` action (FEN-86). MUST equal the value `deploy.sh` seeds into the Convex deployment (same secret as the F8 moderation seam). Unset ⇒ durable Convex calls are rejected (tolerated like undeployed Convex). |
| `GATEWAY_CANVAS_ID` | `default` | Default canvas id == Redis key namespace == drain target (the Convex `_id` in prod; `default` only for local single-canvas smoke) |
| `CANVAS_WIDTH` / `CANVAS_HEIGHT` | `512` / `512` | Geometry fallback (the durable row wins when readable) |
| `FLUSH_INTERVAL_MS` | `2000` | Drain cadence |
| `FLUSH_MAX_BATCH` | `500` | Entries per drain cycle |
| `SNAPSHOT_INTERVAL_MS` | `60000` | Min time between snapshots |
| `SNAPSHOT_EVERY_N_VERSIONS` | `5000` | Snapshot early after this many versions |
| `VIEWER_FLUSH_INTERVAL_MS` | `10000` | Cadence for flushing live `viewerCount` onto the gallery row (FEN-33) |
| `THUMBNAIL_MAX_LONG_SIDE` | `256` | Gallery thumbnail long-side cap in px (`0` disables thumbnails) |

## Build / test / run

```sh
pnpm --filter @canvas/worker typecheck   # tsc --noEmit
pnpm --filter @canvas/worker test        # node:test — pure drain/snapshot/restore logic
pnpm --filter @canvas/worker start       # tsx src/index.ts
```

The drain-batching, snapshot-policy and restore-reconstruction logic are pure
and Redis/Convex-free, covered by `src/test/*.test.ts` so the durability path is
exercised in CI without live infra.

## Compose wiring (DevOps)

Add a `worker` service to the Compose stack running `pnpm --filter @canvas/worker
start`, on the same network as Redis + Convex, with:

```yaml
worker:
  # build the monorepo image (same context as gateway), then:
  command: pnpm --filter @canvas/worker start
  environment:
    REDIS_URL: redis://redis:6379
    CONVEX_SELF_HOSTED_URL: http://convex-backend:3210
    GATEWAY_CANVAS_ID: ${GATEWAY_CANVAS_ID}   # MUST equal the gateway + F2 slug
    GATEWAY_INTERNAL_SECRET: ${GATEWAY_INTERNAL_SECRET}  # FEN-86: == Convex deployment secret
  depends_on: [redis, convex-backend]
  restart: unless-stopped
```

Single replica per canvas in the MVP. Tracked as the DevOps follow-up child of
FEN-57.

## Out of scope / follow-up

Moderation-write durability: `moderate.lua` adopts the per-canvas keys but does
not yet XADD to the stream, so a wipe/restore applied between snapshots is not
replayed on restore (ADR-0003 § Consequences).
