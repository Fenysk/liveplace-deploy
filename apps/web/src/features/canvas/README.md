# Canvas placement — F4 client (FEN-60)

Client half of F4: optimistic pose/erase with rollback on the gateway's verdict.
The server half is FEN-14 (gateway `apps/gateway/src/placement.ts`, commit `981ca29`).

`placement.ts` is a **framework-agnostic** controller (`OptimisticPlacement`) that
consumes the frozen `@canvas/protocol` wire types. It owns the optimism/rollback
state machine and the idempotency seq; it knows nothing about React or the pixel
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

- **ack** `{ seq, charges, max, cooldownUntil }` — confirms the op (pixel kept),
  gauge updated from the ack. `seq` echoes `place.seq`.
- **error** `{ code, message, seq }` — rolls the optimistic pixel back, emits an
  i18n feedback key for `cooldown` / `out_of_bounds` / `invalid_color` /
  `rate_limited` / `banned` (CA6) / `unauthenticated` / `internal`.
- **cooldown** `{ until }` — **carries no seq.** The gateway processes places
  sequentially and TCP preserves reply order, so a cooldown always refers to the
  **oldest** un-acked op; we roll back the head of the insertion-ordered pending
  map. Drives the cooldown countdown via `canvas.feedback.cooldown {seconds}`.

## Idempotency (CA5)

Every op is tagged with a positive, monotonic, **stable** `seq`. `resendQueue()`
re-emits un-acked ops with their **original** seq so a reconnect resend places
exactly once (the gateway dedups on seq for `DEFAULT_OP_TTL_MS`). Locally rejected
ops (out-of-bounds / bad colour / known-empty gauge) never burn a seq.

## Known limitation

Rollback restores the colour the cell displayed at place time. If another user's
authoritative write lands on that same cell inside the sub-second ack window, a
rollback may briefly show the pre-place colour until the next delta/snapshot
corrects it — acceptable for the MVP and standard for r/place-style clients.

## Tests

`node --test apps/web/src/features/canvas/placement.test.ts` (13 cases: optimism,
ack-confirm, error/cooldown rollback, FIFO cooldown correlation, local validation,
gauge empty-block, reconnect resend, repaint-after-snapshot).
