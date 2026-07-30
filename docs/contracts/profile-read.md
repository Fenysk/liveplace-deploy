# Contract — Public profile read path (`/u/{login}`, F11 / FEN-22)

Status: **frozen read-model + view-model; integration pending FEN-11 + FEN-17.**
Owner: Founding Engineer. Consumers: FEN-16 (web shell), FEN-17 (aggregates),
FEN-24 (i18n). Spec: cahier §F11.

The public profile page shows, for a Twitch login: avatar + display name, total
pixels placed / points, canvases joined, and a per-canvas breakdown (pixels,
points, best rank). It exposes **no private data** (no email, no OAuth tokens,
no internal ids).

- **CA1** — page shows pixels placed and points **per canvas**.
- **CA2** — **no private data** is exposed.

Both criteria are enforced and unit-tested in the read-model
`apps/convex/convex/lib/publicProfile.ts` (6 tests) and the page view-model
`apps/web/src/features/profile/profileView.ts` (5 tests). Run:

```
node --test apps/convex/convex/lib/publicProfile.test.ts
node --test apps/web/src/features/profile/profileView.test.ts
```

## Tables

### `profiles` — app-owned public identity mirror (F11)

Populated on sign-in by syncing the Better Auth user (FEN-11). This is the
**only** identity surface the public page reads, so the page never touches the
Better Auth component's private tables.

```ts
profiles: defineTable({
  userId: v.string(),                 // Better Auth user id (== ownerId, §6.1)
  login: v.string(),                  // LOWERCASED Twitch login — the /u/{login} key
  displayName: v.string(),
  avatarUrl: v.union(v.string(), v.null()),
  createdAt: v.number(),
  // locale (F13) may also live here per @canvas/i18n notes — not read by F11.
})
  .index("by_userId", ["userId"])
  .index("by_login", ["login"]),      // REQUIRED for the /u/{login} lookup
```

### `userCanvasStats` — aggregates (owned/written by the worker, FEN-17)

One row per `(userId, canvasId)`. **Never** written on the hot path (G-A1);
maintained by the batch-flush worker. F11 needs the `by_user` index.

```ts
userCanvasStats: defineTable({
  userId: v.string(),                 // == profiles.userId / ownerId
  canvasId: v.id("canvases"),
  pixelsPlaced: v.number(),
  points: v.number(),
  lastPlacedAt: v.optional(v.number()),
  bestRank: v.optional(v.number()),   // best (lowest) leaderboard rank; optional
})
  .index("by_user", ["userId"])              // REQUIRED for the profile read
  .index("by_canvas_points", ["canvasId", "points"]), // also serves F10 leaderboard
```

> **Ask to FEN-17:** please provision `userCanvasStats` with the fields and the
> `by_user` index above (or tell me the divergence and I will adapt the query).
> `bestRank` is optional — leave it unset until F10 lands; the page renders “—”.

## Query — `profiles.getPublicProfile`

Lives at `apps/convex/convex/profiles.ts` once both tables exist. Thin wrapper
over the pure, tested `buildPublicProfile`. CA2 is guaranteed by the allow-list
projection: even if `profiles`/the source row gains a private column, it cannot
leak through `toPublicUser`.

```ts
import { query } from "./_generated/server";
import { v } from "convex/values";
import { buildPublicProfile } from "./lib/publicProfile";

export const getPublicProfile = query({
  args: { login: v.string() },
  handler: async (ctx, { login }) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_login", (q) => q.eq("login", login.trim().toLowerCase()))
      .unique();
    if (!profile) return null; // page renders not-found

    const stats = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_user", (q) => q.eq("userId", profile.userId))
      .collect();

    const canvasCache = new Map<string, { _id: string; slug: string; title: string } | null>();
    for (const s of stats) {
      const id = s.canvasId as unknown as string;
      if (!canvasCache.has(id)) {
        const c = await ctx.db.get(s.canvasId);
        canvasCache.set(id, c ? { _id: id, slug: c.slug, title: c.title } : null);
      }
    }

    return buildPublicProfile({
      profile,
      stats: stats.map((s) => ({
        canvasId: s.canvasId as unknown as string,
        pixelsPlaced: s.pixelsPlaced,
        points: s.points,
        lastPlacedAt: s.lastPlacedAt,
        bestRank: s.bestRank,
      })),
      canvasOf: (id) => canvasCache.get(id) ?? null,
    });
  },
});
```

Result shape (returned to the client) — `PublicProfile` from
`lib/publicProfile.ts`:

```jsonc
{
  "user": { "login", "displayName", "avatarUrl": "string|null", "memberSince": 0 },
  "totals": { "pixelsPlaced": 0, "points": 0, "canvasesJoined": 0 },
  "canvases": [
    { "canvasSlug", "canvasTitle", "pixelsPlaced": 0, "points": 0, "bestRank": "number|null" }
  ] // best (most points) first
}
```

## Web page

- Component: `apps/web/src/features/profile/ProfilePage.tsx` (presentational).
- View-model: `apps/web/src/features/profile/profileView.ts` (pure, tested):
  handles loading / not-found / ready+empty states and locale-aware formatting.
- **Route (FEN-16 web shell):** mount `ProfilePage` at `/u/:login`, passing the
  `login` param. Needs `ConvexProvider` + `I18nProvider` in the tree.
- **api import:** `ProfilePage` imports `api` from `@canvas/convex/api`; the
  Convex package must export its generated api, e.g.

  ```jsonc
  // apps/convex/package.json → "exports"
  "./api": "./convex/_generated/api.js"
  ```

## i18n keys — add to `packages/i18n/src/messages/{en,fr}.ts` (FEN-24)

`en.ts` is the source of truth; `fr.ts` must mirror it (compiler-enforced).

| key                       | en                          | fr                                  |
| ------------------------- | --------------------------- | ----------------------------------- |
| `profile.totals`          | Totals                      | Totaux                              |
| `profile.pixelsPlaced`    | Pixels placed               | Pixels posés                        |
| `profile.points`          | Points                      | Points                              |
| `profile.canvasesJoined`  | Canvases joined             | Canvas rejoints                     |
| `profile.canvas`          | Canvas                      | Canvas                              |
| `profile.bestRank`        | Best rank                   | Meilleur classement                 |
| `profile.rank`            | #{rank}                     | n°{rank}                            |
| `profile.memberSince`     | Member since {date}         | Membre depuis {date}                |
| `profile.empty`           | No canvas joined yet.       | Aucun canvas rejoint pour l’instant.|
| `profile.notFound`        | This player doesn’t exist.  | Ce joueur n’existe pas.             |

## Integration checklist (FEN-22 resume)

- [ ] `profiles` table + `by_login` index in `apps/convex/convex/schema.ts`.
- [ ] Auth-sync writes `profiles` on Twitch sign-in (FEN-11).
- [ ] `userCanvasStats` table + `by_user` index populated by the worker (FEN-17).
- [ ] Add `apps/convex/convex/profiles.ts` (`getPublicProfile`, code above).
- [ ] Export `@canvas/convex/api`.
- [ ] Add `profile.*` i18n keys (FEN-24).
- [ ] Mount `/u/:login` route in the web shell (FEN-16).
- [ ] Verify end-to-end (QA): a seeded user’s page shows per-canvas pixels/points
      (CA1) and the network payload contains no email/token (CA2).
```
