# ADR-0001 — Repo lineage reconciliation & FEN-29 durable schema freeze in project-primary

- Status: **Accepted**
- Date: 2026-06-02
- Owner: Founding Engineer (owns contracts + architecture)
- Issue: FEN-37. Unblocks: FEN-30 (leaderboard/profile/gallery UI reads).

## Context

While implementing the FEN-30 UI read queries, two **divergent git lineages**
(different root histories — not branches) of the same Convex app were found:

- **A — `project-primary`** (`projects/…/_default`, branch `master`,
  `WORKSPACE_STRATEGY=project_primary`). The tree where the Dev team integrated
  its work: `canvases.ts`, `points.ts`, `palettes.ts`, `gallery.ts`, `auth.ts`,
  `lib/publicProfile.ts`, `stats.ts`, plus web / gateway / redis-scripts. The
  runtime checks every agent out here. Schema is **points-oriented** and carries
  the gallery discovery fields **denormalised onto `canvases`**.
- **B — workspace `50be08f2`** (an earlier, separate root). Carries
  `canvas.ts` / `aggregate.ts` / `flush.ts` / `leaderboard.ts` / `rank.ts` and a
  **separate versioned `thumbnails` table**; `userCanvasStats` is
  pixel/placement-oriented (`firstPlacementTs`, `lastPlacementVersion`, `lastX`,
  `lastY`, `lastColor`).

The frozen read contracts I own — `docs/contracts/profile-read.md` and
`docs/contracts/gallery-read.md` — were written against **A's** `canvases`
model. The FEN-29 aggregate/thumbnail work was prototyped in **B** and never
integrated into A, which is where everyone actually works.

## Decision

### 1. Canonical lineage: **A (`project-primary`)**

A is the single source of truth for Dev. It is where the runtime checks out, where
the whole team integrated, and what the frozen contracts target. **B is retired**
as a lineage; any not-yet-ported logic from B (the persistence worker, snapshot
flush) is re-implemented against A's schema, not merged wholesale.

### 2. Gallery thumbnails: **denormalised fields on `canvases`, NOT a `thumbnails` table**

The frozen `gallery-read.md` contract specifies the discovery data as optional,
off-hot-path columns on `canvases` — `thumbnailStorageId`, `thumbnailVersion`,
`lastActivityAt`, `viewerCount`, with index `by_public_activity`. **A already has
these**, and `gallery.ts:listPublicCanvases` already reads them (committed in
F12 / FEN-23). The gallery query is therefore **implementable today in A** — no
`thumbnails` table is required for the MVP gallery. B's versioned `thumbnails`
table is a worker-internal artifact; the persistence worker (FEN-17) writes the
four denormalised fields onto A's `canvases` rows instead. A separate snapshot
store, if ever needed for history, is a future concern tracked under D2
(snapshot format) and is out of scope for FEN-30.

### 3. `userCanvasStats`: **A's points+pixels shape is frozen**

A's row already carries everything both read contracts need:

```
userCanvasStats(userId, canvasId, points, pointsEarned, pixelsPlaced,
                gaugeMaxBonus, bestRank?, lastPlacedAt?, updatedAt)
  .index("by_canvas_user", ["canvasId","userId"])   // upsert
  .index("by_user",        ["userId"])               // F11 profile
  .index("by_canvas_points",["canvasId","points"])   // F10 leaderboard
```

This satisfies `profile-read.md` (`pixelsPlaced`, `points`, `lastPlacedAt`,
`bestRank`, `by_user`) **and** the leaderboard (`by_canvas_points`). B's
placement-internal fields (`lastX/lastY/lastColor`, `lastPlacementVersion`) are
**worker implementation detail**, not part of any read contract; the worker may
keep such state in Redis or a private table without changing this frozen shape.

### 4. `profiles.by_login`: **added** (the one genuine schema gap)

A's `profiles` had only `by_authUserId` + `by_twitchId`. The profile contract
requires a `by_login` lookup for `/u/{login}`. Added in this change.
**Field-naming reconciliation:** the canonical column is `authUserId` (committed
F2/F11), while the frozen read-model's `ProfileRow`/`StatRow` say `userId` — the
*same* Better Auth id (§6.1). The query layer adapts the column to the read-model
(`profiles.ts`); the schema column name is unchanged.

### 5. Leaderboard: **`stats.ts:leaderboard` (A) is canonical**

A's `stats.ts:leaderboard` (FEN-30) over `by_canvas_points` + the pure, tested
`lib/leaderboard.ts` is retained. B's `getLeaderboard`/`leaderboard.ts` belonged
to the retired lineage and is **dropped** to avoid a duplicate API.

## Consequences

- FEN-30's **profile** and **gallery** reads are now implementable in A: gallery
  already works against the canvas fields; profile is unblocked by `by_login` +
  the new `profiles.ts:getPublicProfile` (thin wrapper over the frozen
  read-model).
- The persistence worker (FEN-17) targets A's schema: it writes the four
  discovery fields onto `canvases` and maintains `userCanvasStats`. It does **not**
  introduce a `thumbnails` table for the gallery.
- No data migration: B is abandoned, not merged; A grows additively (one index).

## Verification

`profiles.by_login` and `profiles.ts` ride the existing frozen read-models, which
remain green:

```
node --test apps/convex/convex/lib/publicProfile.test.ts \
            apps/convex/convex/lib/leaderboard.test.ts \
            apps/convex/convex/lib/gallery.test.ts
```

End-to-end query verification (live `convex dev` with generated types + a seeded
user) is owned by QA / FEN-22 integration, per `profile-read.md`'s checklist.
