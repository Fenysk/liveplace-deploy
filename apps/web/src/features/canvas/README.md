# Canvas placement — F4 client (FEN-60, cid migration FEN-70)

Client half of F4: optimistic pose/erase with rollback on the gateway's verdict.
The server half is FEN-14 (gateway `apps/gateway/src/placement.ts`); the op id was
ratified as the opaque `cid` (not `seq`) in FEN-63 (gateway commit `ccb6776`,
contract `1aa494a` §cid) and the client migrated to it in FEN-70.

`placement.ts` is a **framework-agnostic** controller (`OptimisticPlacement`) that
consumes the frozen `@canvas/protocol` wire types. It owns the optimism/rollback
state machine and the `cid` op id; it knows nothing about React or the pixel
backing store. The eventual F3 canvas client plugs in by implementing a two-method
`PlacementSurface` and forwarding server frames.

## Wiring (for the F3 net client)

```ts
const placement = new OptimisticPlacement({
  width, height,          // from the `welcome` frame — never hard-coded
  paletteSize,            // this canvas's palette length
  surface,                // { getPixel, setPixel } over the display buffer
  onGauge: (g) => setGauge(g),         // render current/max + countdown (D1)
  onFeedback: (f) => toast(t(f.messageKey, f.params)), // @canvas/i18n canvas.feedback.*
});

// user clicks a cell:
const msg = placement.place(x, y, color); // color 0 == erase (EMPTY_COLOR)
if (msg) socket.send(JSON.stringify(msg));

// incoming server text frame:
placement.handle(serverMessage); // routes ack / error / cooldown / gauge

// on reconnect, after the welcome handshake:
for (const m of placement.resendQueue()) socket.send(JSON.stringify(m));

// after a full snapshot replace (resyncRequired):
placement.repaintPending();
```

## Contract details it mirrors

- **ack** `{ cid, charges, max, cooldownUntil }` — confirms the op (pixel kept),
  gauge updated from the ack. `cid` echoes `place.cid`; we commit the pending
  pixel keyed by that `cid`. (The frame still carries a deprecated transitional
  `seq` the controller ignores.)
- **error** `{ code, message, cid }` — rolls the optimistic pixel back (matched by
  `cid`), emits an i18n feedback key for `cooldown` / `out_of_bounds` /
  `invalid_color` / `rate_limited` / `banned` (CA6) / `unauthenticated` / `internal`.
- **cooldown** `{ until }` — **carries no cid.** The gateway processes places
  sequentially and TCP preserves reply order, so a cooldown always refers to the
  **oldest** un-acked op; we roll back the head of the insertion-ordered pending
  map. Drives the cooldown countdown via `canvas.feedback.cooldown {seconds}`.

## Idempotency (CA5) — the `cid` op id

Every op is tagged with an **opaque, client-generated `cid`** (a UUID by default;
`genCid` is injectable for tests). `resendQueue()` re-emits un-acked ops with their
**original** `cid` so a reconnect resend places exactly once — the gateway claims a
per-`(canvas, user, cid)` key with `SET NX` for `DEFAULT_OP_TTL_MS`. The id MUST be
opaque and stable per op: a per-session integer that resets to `1` on restart can
collide with a prior op and get a legit placement dropped as a false replay (why we
default to a UUID, not a counter — ratified FEN-63). Locally rejected ops
(out-of-bounds / bad colour / known-empty gauge) never mint a `cid`.

## Known limitation

Rollback restores the colour the cell displayed at place time. If another user's
authoritative write lands on that same cell inside the sub-second ack window, a
rollback may briefly show the pre-place colour until the next delta/snapshot
corrects it — acceptable for the MVP and standard for r/place-style clients.

## Tests

`node --test apps/web/src/features/canvas/placement.test.ts` (15 cases: optimism,
ack-confirm by cid, error/cooldown rollback, FIFO cooldown correlation, local
validation, gauge empty-block, reconnect resend with same cid, repaint-after-
snapshot, and the default UUID cid generator round-trip).
