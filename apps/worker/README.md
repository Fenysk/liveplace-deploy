# @canvas/worker — persistence worker (R2 / FEN-57)

Standalone background service that owns the **durable** side of LivePlace. It is
**not on the hot path** (G-A1): a pixel placement only touches Redis (gateway +
`place.lua`); this worker moves that data to the durable Convex layer
out-of-band, and rebuilds Redis from Convex on cold start.

It is the binary that joins the two ends built earlier:

- **Redis source** — `place.lua` XADDs every accepted placement to
  `canvas:{slug}:stream` as `{x,y,color,version,userId,ts}` (FEN-54, ADR-0003).
- **Convex target** — the slug-addressed `worker:*` API (FEN-47).
- **Contract** — [`docs/contracts/persistence-worker.md`](../../docs/contracts/persistence-worker.md)
  and [`docs/adr/0003-redis-hot-path-per-canvas-stream.md`](../../docs/adr/0003-redis-hot-path-per-canvas-stream.md).

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

A best-effort Redis flush lock (`src/lock.ts`, `G-Perf4`) keeps two instances
from double-draining; correctness does not depend on it.

## Identity (ADR-0001)

The worker addresses Convex by the canvas **slug**, fixed equal to the gateway's
`GATEWAY_CANVAS_ID` and the per-canvas Redis key namespace (`canvasKeys(slug)`).
All three MUST be the same value for a deployment.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `CONVEX_SELF_HOSTED_URL` | `http://localhost:3210` | Self-hosted Convex backend (public `worker:*` fns) |
| `GATEWAY_CANVAS_ID` | `default` | Canvas slug == key namespace == drain target |
| `CANVAS_WIDTH` / `CANVAS_HEIGHT` | `512` / `512` | Geometry fallback (the durable row wins when readable) |
| `FLUSH_INTERVAL_MS` | `2000` | Drain cadence |
| `FLUSH_MAX_BATCH` | `500` | Entries per drain cycle |
| `SNAPSHOT_INTERVAL_MS` | `60000` | Min time between snapshots |
| `SNAPSHOT_EVERY_N_VERSIONS` | `5000` | Snapshot early after this many versions |

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
  depends_on: [redis, convex-backend]
  restart: unless-stopped
```

Single replica per canvas in the MVP. Tracked as the DevOps follow-up child of
FEN-57.

## Out of scope / follow-up

Moderation-write durability: `moderate.lua` adopts the per-canvas keys but does
not yet XADD to the stream, so a wipe/restore applied between snapshots is not
replayed on restore (ADR-0003 § Consequences).
