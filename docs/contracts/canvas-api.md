# Contract — Canvas management API (F2 / FEN-12)

The Convex functions a streamer dashboard, the WS gateway, and the public/OBS
views build against to create, configure, and run canvases. Business rules are
frozen in `apps/convex/convex/lib/canvasRules.ts` (pure, unit-tested); the Convex
handlers live in `apps/convex/convex/canvases.ts` and `palettes.ts`.

## Schema (frozen by F2)

`canvases` and `palettes` per cahier §6.2 / §6.3. Notable points:

- `ownerId: string` — the Better Auth user id (`ctx.auth.getUserIdentity().subject`),
  **not** a `Id<"users">`. Identity is owned by the Better Auth component (§6.1).
- `cellCount: number` — denormalised count of non-empty cells, maintained by the
  durable flush worker. F2 reads it only, to enforce the CA5 resize guard without
  scanning `canvasCells`. Additive extension to §6.2.
- Indexes: `canvases[by_owner_status, by_slug, by_public_status]`,
  `palettes[by_owner]`.

## Mutations (auth required; owner-only unless noted)

| Function | Args | Effect |
|---|---|---|
| `canvases:createCanvas` | `{ title?, slug?, width?=100, height?=100, paletteId?, isPublic?=false, eventStartAt?, eventEndAt? }` | Creates an **active** canvas (CA1). Archives the owner's previous active canvas (one-active invariant). Defaults to the system palette. Returns `Id<"canvases">`. |
| `canvases:updateCanvasConfig` | `{ canvasId, title?, width?, height?, paletteId?, isPublic?, eventStartAt?, eventEndAt? }` | Patches config. **Active canvases only** (archived = read-only). Dimension change rejected if `cellCount > 0` (CA5). |
| `canvases:activateCanvas` | `{ canvasId }` | Makes this canvas active, archiving the current active one (CA2). Reactivates archived canvases. |
| `canvases:archiveCanvas` | `{ canvasId }` | Archives (read-only, non-destructive, reactivable). |
| `canvases:setPlacementOpen` | `{ canvasId, open }` | Emergency freeze toggle (F8). Independent of status. |
| `palettes:ensureDefaultPalette` | `{}` | Idempotently seeds the 16-colour system palette. Run once at deploy (`pnpm --filter @canvas/convex seed`). |
| `palettes:createPalette` / `updatePalette` | `{ colors[] }` / `{ paletteId, colors[] }` | Custom palettes (2–64 colours, index 0 = empty, contiguous, `#rrggbb`). `updatePalette` bumps `version` to invalidate the Redis colour cache. |

Validation errors throw `CanvasRuleError` with a stable `code`
(`invalid_dimensions`, `invalid_palette`, `invalid_title`, `invalid_slug`,
`invalid_event_window`, `resize_forbidden_non_empty`, `not_owner`,
`canvas_archived`).

## Queries

| Function | Args | Returns |
|---|---|---|
| `canvases:listMyCanvases` | `{}` | The caller's canvases, newest first. |
| `canvases:getCanvasBySlug` | `{ slug }` | Public canvas metadata (web / OBS). |
| `canvases:canPlace` | `{ canvasId }` | **Placement contract** for the WS gateway: `{ allowed, reason? }`. |
| `palettes:listAvailablePalettes` | `{}` | System default + the caller's custom palettes. |

## Placement contract (`canPlace`) — CA3 + CA4

The single source of truth for "may *this caller* place a pixel here, now?". The
WS gateway MUST consult it (directly or via the same `evaluatePlacement` rule)
before minting a place ticket. Decision order (for a clear client reason):

1. `canvas_archived` — archived canvases refuse **everyone, including the owner** (CA3).
2. `placement_closed` — `placementOpen === false`, emergency freeze, refuses everyone.
3. `outside_event_window` — outside `[eventStartAt, eventEndAt)`, **non-owners** are
   refused; the **owner may still test** (CA4).
4. otherwise `{ allowed: true }`.

`evaluatePlacement(canvas, { isOwner, now })` in `lib/canvasRules.ts` is exported
for reuse by the gateway so the rule is never duplicated.

## Tests

`node --test apps/convex/convex/lib/canvasRules.test.ts` — covers the decision
logic behind CA1–CA5 (bounds, palette, slug, event window, placement, resize
guard, one-active planner). End-to-end handler behaviour is validated at
`convex dev` / deploy time (runtime ticket [FEN-25](/FEN/issues/FEN-25)).
