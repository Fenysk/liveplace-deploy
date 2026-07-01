# ADR-0001 — Reconcile the persistence-worker and F2 `canvases` durable schema

- Status: **Accepted**
- Date: 2026-06-02
- Owner / decider: Founding Engineer
- Affects: FEN-36 (this decision), FEN-33 (worker → gallery discovery fields),
  FEN-17 / FEN-29 / FEN-31 (persistence worker), FEN-12 / FEN-23 (F2 canvases +
  gallery)

## Context

Two divergent durable tables, both named `canvases`, evolved on two diverged
`master` HEADs and cannot coexist in one Convex deployment:

- **F2 model** (`_default`, FEN-12 + gallery FEN-23) — the canonical product
  model. Rows are keyed by Convex `_id` with business keys `slug` / `ownerId`,
  carry `isPublic` / `status`, and hold the 4 gallery discovery fields
  (`lastActivityAt`, `viewerCount`, `thumbnailStorageId`, `thumbnailVersion`)
  **on the row** (additive, optional, off the hot path — see
  `docs/contracts/gallery-read.md`). `userCanvasStats` is keyed by
  `id("canvases")`. **Every product read-model already targets this model**:
  gallery (FEN-23), profile (FEN-22), leaderboard (FEN-21), points (FEN-18).
- **Worker model** (FE tree, FEN-17/29/31) — predates F2. `canvases` keyed by a
  string `canvasId` (the WS `CanvasConfig.canvasId`, e.g. `"main"`), thumbnails
  in a separate versioned `thumbnails` table, `userCanvasStats` keyed by
  `canvasId: string`.

Two concrete blockers for FEN-33:

1. **Table collision** — one Convex deployment cannot hold two `canvases`
   tables.
2. **No mapping** — the worker knows only the string `canvasId`; the F2 row has
   no such column (it has `slug`). There was no defined `canvasId → F2 row`
   resolution.

Both are frozen-schema concerns owned by the Founding Engineer, and the decision
is also a two-master integration step.

## Decision

**Option A — unify on the F2 canonical `canvases` table.** The worker converges
onto the F2 model; the worker's string-keyed `canvases` is retired.

Bridge key: **`canvasId == slug`**. The worker resolves the F2 row via the
existing `by_slug` index, using its WS `canvasId` as the slug.

This identity is **enforced by operator configuration, not assumed**: the
gateway already reads its canvas id from `GATEWAY_CANVAS_ID`
(`apps/gateway/src/config.ts`). Deployments MUST set `GATEWAY_CANVAS_ID` to the
target canvas's F2 `slug`. The gallery already routes click-through to
`/c/{slug}`, so this is the natural shared identifier.

Concretely:

- The F2 `canvases` table (`apps/convex/convex/schema.ts`) is the single durable
  canvas table. Row creation stays owned by F2 `createCanvas` — the worker never
  creates canvas rows.
- Worker mutations (`ensureCanvas` / `applyFlush` / `recordSnapshot` /
  `recordThumbnail` / aggregate) migrate to resolve the F2 `_id` via `by_slug`
  and write onto the F2 row / F2-`_id`-keyed side tables.
- The string-keyed `userCanvasStats` folds into the F2 `userCanvasStats`
  (`canvasId: id("canvases")`). Snapshots / placements may remain as side tables
  but re-keyed to the F2 `_id`.
- Thumbnails: the worker writes `thumbnailStorageId` / `thumbnailVersion`
  **onto the F2 row** (no separate versioned `thumbnails` table); `gallery.ts`
  already reads them off the row with safe defaults.

### Resolution-miss semantics (ownership boundary)

If no F2 row matches the worker's `canvasId`/slug yet (e.g. canvas not created),
the worker's discovery-field write is a **no-op** (idempotent), not a create.
F2 `createCanvas` is the sole creator of canvas rows. This keeps a clean
ownership boundary and avoids the worker manufacturing partial rows.

### Monotonicity

Discovery-field writes are idempotent and **monotonic** on `lastActivityAt` and
`thumbnailVersion` (never move them backwards), so out-of-order worker flushes
cannot regress gallery state.

## Consequences

- **FEN-33 becomes a mostly mechanical land** (the FEN-33 brief's plan stands):
  an additive F2 mutation `canvas:setGalleryFields` (resolve `by_slug`, patch
  the 4 optional fields, idempotent + monotonic) + worker wiring + tests. No F2
  schema change is required — the discovery fields already exist on the row.
- One durable canvas model for the whole product; no permanent dual model to
  maintain (the cost Option B would have locked in).
- **Operational requirement:** `GATEWAY_CANVAS_ID` must equal the canvas `slug`.
  This must be captured in deployment config / `.env` docs and the Compose
  setup. Until multi-canvas is in scope, this is a single value.
- The two-master merge folds the worker tree's durable layer onto the F2 schema;
  the worker's bespoke `canvases` / string-keyed `userCanvasStats` / separate
  `thumbnails` tables are dropped in favor of the F2 equivalents.

## Options considered

- **Option A (chosen)** — unify on F2; worker resolves `by_slug`, `canvasId ==
  slug`. F2 is the frozen canonical model every read-model already targets, so
  the worker (the outlier, predating F2) converges onto it.
- **Option B (rejected)** — keep the worker model + a `gallery:updateDiscovery`
  bridge mutation. Still requires renaming one `canvases` table to remove the
  collision **and** a `canvasId → slug` map — most of A's work plus a permanent
  dual model and divergent read/write schemas to maintain indefinitely.

## References

- FEN-36 (decision), FEN-33 (landing) and its
  `schema-reconciliation` brief document.
- `apps/convex/convex/schema.ts` — F2 `canvases` (`by_slug`, discovery fields).
- `apps/convex/convex/lib/gallery.ts`, `docs/contracts/gallery-read.md` — gallery
  read path reading the discovery fields off the row.
- `apps/gateway/src/config.ts` — `GATEWAY_CANVAS_ID` (the `canvasId == slug`
  enforcement point).
