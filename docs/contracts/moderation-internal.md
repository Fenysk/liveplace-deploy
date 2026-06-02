# Moderation internal seam — Convex (F8/FEN-52) ↔ Gateway (FEN-19)

The F8 moderation **decision + journal** layer lives in Convex
(`apps/convex/convex/moderation.ts`). It authorises a mod action, folds the
durable placement log into the exact `{x,y,color}` cells to write, records the
ban / overlay / audit, then asks the **gateway** to apply the Redis side-effects.
Convex never touches Redis (G-A1). This file is the HTTP contract between the two
sides. The gateway endpoints below are **owned by FEN-19** (out of scope for
FEN-52); until they exist, the Convex actions record durable state and report the
dispatch as `gateway_not_configured` (no throw), so the layer is deployable now.

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

Response `2xx` on success. Convex stamps the audit row with the status.

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
  log — author + colour + version) into the cell list. "What was underneath" is
  the stack entry below the current top per cell. This log IS the `pixelEvents`
  history FEN-10 named; it is not duplicated.
- **Durable record**: `bans`, `pixelModeration` (CA2 deleted-pixel overlay,
  kept invisible-but-recorded with author + reason), `auditLog` (CA6),
  `canvasModerators` (Twitch sync, F8.5 via Helix `/moderation/moderators`).

## Placement gate

The gateway's placement path SHOULD reject a banned author. Convex exposes
`moderation:isBanned({ canvasId, userId }) -> boolean` for that check (pairs with
the existing `canvases:canPlace` contract).
