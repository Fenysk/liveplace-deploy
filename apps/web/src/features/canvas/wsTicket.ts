/**
 * The canvas WebSocket ticket resolver (FEN-184 / regression guard FEN-267).
 *
 * The gateway resolves a socket's `userId` from the Convex JWT passed as the
 * `?token=` query param (apps/gateway/src/auth.ts `extractToken`), and ONLY an
 * identified socket receives the per-user `gauge` frame that ungates placement —
 * a tokenless connect is admitted as an anonymous read-only viewer. So the
 * interactive canvas MUST send the live JWT, while OBS / signed-out viewers send
 * nothing and watch read-only.
 *
 * This factory is the single place that encodes that decision so it is unit
 * testable in isolation. FEN-267 regressed precisely because the wiring was
 * dropped during a CanvasView refactor and every socket connected anonymously
 * (no gauge ⇒ "Loading the canvas…" forever, no placement). `isAuthed` is read
 * at CALL time so the same bound resolver returns the token the instant Convex
 * confirms auth; the caller drives a reconnect on that flip to re-run it.
 *
 * Deliberately free of any Convex / Better Auth import so it stays a pure,
 * unit-testable decision: the caller ({@link CanvasViewLive}) injects the real
 * `fetchConvexToken`.
 */

/**
 * Build the resolver {@link CanvasNetClient} calls per (re)connect.
 *   - `isAuthed()` true  → resolve the live Convex JWT (`fetchToken`);
 *   - `isAuthed()` false → resolve `null` (anonymous read-only).
 *
 * Gate on Convex's CONFIRMED auth state, never the raw Better Auth session: the
 * session flips authenticated ~1s before `authClient.convex.token()` can mint a
 * JWT, so an early call would return null and connect anonymously anyway (FEN-182).
 */
export function makeWsTicketResolver(
  isAuthed: () => boolean,
  fetchToken: () => Promise<string | null>,
): () => Promise<string | null> {
  return () => (isAuthed() ? fetchToken() : Promise.resolve(null));
}
