# Contract — Public gallery read path (F12 / FEN-23)

Status: **frozen read-model + view-model; thumbnail/viewer integration pending the
persistence worker (FEN-17).**
Owner: Dev Full-stack. Consumers: Dev Frontend (gallery page/OBS discovery),
Dev Backend (worker — writes the discovery fields), i18n (FEN-24).
Spec: cahier §F12.

The gallery is canvas discovery: a paginated feed of every **public + active**
canvas, each shown with a pre-generated thumbnail, title, streamer, and live
viewer count, ordered by activity. Clicking a card opens the canvas.

- **CA1** — lists public, active canvases with a thumbnail + viewer count.
- **CA2** — clicking a card opens the canvas (routes to `/c/{slug}`).
- **G-Perf3** — thumbnails are **never** computed on the fly. The gallery only
  reads a pointer to a blob the worker pre-rendered off the hot path.

Pure logic is unit-tested in the read-model `apps/convex/convex/lib/gallery.ts`
(8 tests) and the page view-model `apps/web/src/features/gallery/galleryView.ts`
(3 tests). Run:

```
node --test apps/convex/convex/lib/gallery.test.ts
node --test apps/web/src/features/gallery/galleryView.test.ts
```

## Schema (additive F12 extension to `canvases`, §6.2)

All discovery fields are **optional**, **off the hot path** (G-A1), and
maintained by the worker/gateway — never on pixel placement:

```ts
canvases: defineTable({
  // …F2 fields…
  lastActivityAt: v.optional(v.number()),       // epoch ms of latest placement; seeded to createdAt
  viewerCount: v.optional(v.number()),          // current live viewers
  thumbnailStorageId: v.optional(v.id("_storage")), // latest pre-rendered preview blob
  thumbnailVersion: v.optional(v.number()),     // canvas version the thumbnail depicts
})
  .index("by_public_activity", ["isPublic", "status", "lastActivityAt"]) // REQUIRED for the feed
```

`createCanvas` seeds `lastActivityAt = createdAt` and `viewerCount = 0` so a
brand-new public canvas already sorts and renders; everything else defaults to
`undefined` until the worker fills it in.

### Who writes what (worker / gateway — FEN-17)

| Field | Writer | Cadence |
|---|---|---|
| `thumbnailStorageId` + `thumbnailVersion` | persistence worker | when it re-renders a preview from a snapshot (off hot path) |
| `lastActivityAt` | persistence worker | on each batch flush, = ts of newest drained placement |
| `viewerCount` | gateway / worker | periodic presence flush (NOT per pixel) |

The gallery degrades gracefully before any of these exist: missing thumbnail →
`thumbnailUrl: null` (card shows a placeholder), missing viewer count → `0`,
missing activity → falls back to `createdAt`.

## Query

| Function | Args | Returns |
|---|---|---|
| `gallery:listPublicCanvases` | `{ paginationOpts }` | Convex pagination envelope `{ page: GalleryItem[], isDone, continueCursor }`, most-active first. Anonymous-safe. |

```ts
GalleryItem = {
  slug: string;                 // CA2 click-through key → /c/{slug}
  title: string;
  streamer: { login: string; displayName: string; avatarUrl: string | null };
  thumbnailUrl: string | null;  // resolved from thumbnailStorageId; null if none yet (G-Perf3)
  viewerCount: number;          // non-negative integer
  lastActivityAt: number;       // activity sort key
}
```

Ordering is `lastActivityAt` desc via the `by_public_activity` index, so
pagination is correct and stable. Ties break by viewer count then slug
(`compareByActivity`, exported for SSR/tests).

### Security & cost

- **Allow-list projection (CA2 boundary).** `toGalleryItem` surfaces only the
  fields above. `ownerId` (Better Auth id), `paletteId`, event windows, and
  internal counters never leave the server, even if new private columns are
  added to the row later.
- **No N+1.** The per-item profile join + `storage.getUrl` run once per card but
  are bounded by `paginationOpts.numItems` (one page), not the whole table.

## i18n keys (FEN-24)

`gallery.title`, `gallery.viewers` (`{count}`), `gallery.empty` — added to
`@canvas/i18n` (FR/EN). The view-model returns keys; it never resolves strings.

## Note for the Founding Engineer — schema reconciliation

This contract builds on the `canvases` model owned by F2/FEN-12 in
`apps/convex/convex/schema.ts` (`ownerId`/`slug`/`isPublic`/`status`), which the
F12 acceptance criteria (`isPublic=true`+`status=active`) are written against.
The persistence worker (FEN-17) currently lives against a different durable
schema (canvases keyed by `canvasId: string`, plus a versioned `thumbnails`
table). The worker must write the four discovery fields above onto the **F2
`canvases` rows** (or the two schemas must be reconciled) before the gallery
shows real thumbnails/viewer counts. Tracked back to FEN-23.
