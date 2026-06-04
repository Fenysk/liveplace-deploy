# Moderation internal seam — Convex (F8/FEN-52) ↔ Gateway (FEN-19)

> Companion to the **frozen schema + logic contract** `docs/contracts/moderation.md`
> (FE sign-off 2026-06-02). That doc owns the tables, mutation signatures and the
> restore model; **this** doc owns only the HTTP seam between Convex and the
> gateway. The two must stay consistent.

The F8 moderation **decision + journal** layer lives in Convex
(`apps/convex/convex/moderation.ts`). It authorises a mod action, derives the
exact `{x,y,color}` cells to write from the durable `placements` log
(`by_canvas_cell`), records the ban / `pixelModeration` overlay / `auditLog`,
then asks the **gateway** to apply the Redis side-effects. Convex never touches
Redis (G-A1). The gateway endpoints below are **owned by FEN-19/Backend** (out of
scope for FEN-52); until they exist, the Convex actions record durable state and
report the dispatch as `gateway_not_configured` (no throw), so the layer is
deployable now.

> **Binding invariant (from the frozen contract, for FEN-19):** every cell
> `moderate.lua` overwrites MUST be `XADD`-ed to `canvas:{id}:stream` with a
> freshly-bumped `version` (same payload shape as `place.lua`: `x,y,color,version,by,ts`).
> The flush worker then persists it into `placements`, so the durable log stays
> resync-consistent and the derive-underneath logic keeps working. Echo the bumped
> version back in the `/internal/moderate` response (`{ "version": N }`) and Convex
> stamps it onto the `pixelModeration.overwriteVersion` of the action.

## Auth

Convex → gateway calls carry `Authorization: Bearer ${GATEWAY_INTERNAL_SECRET}`
when `GATEWAY_INTERNAL_SECRET` is set. The gateway must reject internal routes
that lack the shared secret. Base URL: `GATEWAY_INTERNAL_URL` (Convex env).

## `POST /internal/moderate`

Apply a computed bulk overwrite via `moderate.lua` (already shipped, FEN-19,
commit `8ee5c2b`). The gateway builds `moderateArgs` from this body — Convex has
already decided the colours (`0` = erase, otherwise the colour to (re)write).

```jsonc
{
  "slug": "streamerlogin",   // == GATEWAY_CANVAS_ID == canvases.slug (ADR-0001)
  "width": 100,
  "height": 100,
  "paletteSize": 16,
  "cells": [{ "x": 1, "y": 1, "color": 3 }] // one bulkDelta, atomic
}
```

Response `2xx`; echo `{ "version": N }` (the last bumped write counter) so Convex
can stamp `pixelModeration.overwriteVersion`. The response also reports `applied`
(cells actually written).

### Viewer fan-out side-effect — `moderationEvent` (FEN-156)

A wipe reaches a connected viewer as ordinary `delta` frames, indistinguishable
from normal placements — so the fresco changes with no explanation (the anxiety
UX Lot I / FEN-121 fixes; the viewer reducer `moderationNotice.ts` is ready and
keys off a monotonic `bulkChangeSeq`). To give the bulk overwrite an attribution
the deltas lack, the gateway — when `moderate.lua` applied **≥ 1** cell — emits an
**action-level** signal, distinct from a reconnect `resyncRequired` (a network
event, which must NOT read as moderation):

- The gateway that handled the call publishes ONE message on the gateway-only
  Redis channel `canvas:moderation-events` (`MODERATION_EVENT_CHANNEL`, payload
  JSON `{ canvasId, version, cells }`). This is the cross-instance fan-out the
  per-pixel deltas already use, mirrored, so a viewer connected to ANY gateway
  instance is notified — not just those on the instance that received the HTTP call.
- Every instance subscribes and re-broadcasts to its local viewers the additive
  `@canvas/protocol` frame `{ t: "moderationEvent", version, cells }` (server →
  client only; an unaware client ignores it and still applies the deltas, so
  `PROTOCOL_VERSION` stays 1). The web `net.ts` bumps `bulkChangeSeq` on it and
  `areaChanged` lights up with no further VM work.

A 0-applied call (malformed batch) changed nothing visible → no event. A pure ban
(no `/internal/moderate`) and a freeze/unfreeze are NOT announced here: nothing was
overwritten; freeze legibility is already observable via `canPlace`→`placement_closed`.

## `POST /internal/ban`

Push a ban/unban to the gateway so it (re)allows or rejects the user's live
placements immediately. The durable source stays `bans` in Convex (`isBanned`).

```jsonc
{ "slug": "streamerlogin", "userId": "better-auth-id", "banned": false }
```

## `POST /internal/flush`

Force the persistence worker to drain the Redis→Convex buffer for `slug` and
**await** completion, so the durable `placements` log reflects pre-action state
before a mass action (issue scope §7). Convex calls this best-effort before every
moderate dispatch.

```jsonc
{ "slug": "streamerlogin" }
```

## `POST /internal/freeze`

Emergency freeze toggle (F8.4): SET (`"1"`) or DEL the `canvas:frozen` Redis flag
checked by `place.lua`. Convex has already patched the durable mirror
(`canvases.placementOpen = !frozen`).

```jsonc
{ "slug": "streamerlogin", "frozen": true }
```

## What Convex owns (no gateway involvement)

- **Authz**: owner (`canvases.ownerId`) or active `canvasModerators` row.
- **Cell decision**: `lib/moderation.ts` folds `placements` (the FEN-47 append
  log — author + colour + version) into the cell list via `by_canvas_cell`. "What
  was underneath" is the most recent placement below the current top per cell
  (skipping a wiped user's own stacked pixels). This log IS the per-placement
  history FEN-10 named `pixelEvents`; it is not duplicated.
- **Durable record**: `bans`, `pixelModeration` (CA2 overlay — `removedUserId` /
  `removedColor` / `removedVersion` / `underneathColor` / `modActionId` /
  `restored`, kept invisible-but-recorded), `auditLog` (CA6), `canvasModerators`
  (Twitch sync, F8.5 via Helix `/moderation/moderators`, `source="twitch_sync"`).

## Placement gate

The gateway's placement path SHOULD reject a banned author. Convex exposes
`moderation:isBanned({ canvasId, userId }) -> boolean` for that check (pairs with
the existing `canvases:canPlace` contract).
