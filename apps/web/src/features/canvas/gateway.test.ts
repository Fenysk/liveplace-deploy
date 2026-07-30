/**
 * Unit tests for the client-side WS URL builder (S4a — FEN-1566).
 *
 * Covers:
 *   - gatewayWsPath: path-only builder (DOM-free, always testable)
 *   - invariant: path stays on /ws (proxy only forwards that route, FEN-326/441)
 *   - canvas selection: ?canvas=<canvasId> appended when provided (S0/S3 — FEN-1560)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayWsPath } from "./gateway.ts";

// ── Proxy invariant: always /ws base path ──────────────────────────────────────
// FEN-326 / FEN-441: ALL slugs MUST resolve to the bare `/ws` path — the only WS
// route the Caddy reverse proxy forwards to the gateway (`@ws path /ws /ws/*`).
// Emitting `/canvas/{slug}/ws` for any slug falls through to the SPA/static
// handler → 200/HTML instead of a 101 upgrade, so the socket never opens (QA
// FEN-312, QA FEN-423). Per-slug routing is a post-MVP proxy concern.

test("default canvas (null slug) uses the bare /ws path", () => {
  assert.equal(gatewayWsPath(null), "/ws");
});

test("explicit 'default' slug also uses /ws", () => {
  assert.equal(gatewayWsPath("default"), "/ws");
});

test("named (non-default) canvases also use /ws (proxy only forwards /ws)", () => {
  assert.equal(gatewayWsPath("fenysk"), "/ws");
  assert.equal(gatewayWsPath("team-event"), "/ws");
  assert.equal(gatewayWsPath("main"), "/ws");
});

// ── Canvas selection: ?canvas= query param (S0/S3 — FEN-1560) ─────────────────
// When canvasId is provided the client must transmit it as ?canvas=<id> on the
// WS upgrade so the gateway can route the connection to the right per-user canvas.
// Path MUST stay on /ws regardless (proxy constraint above still applies).

test("canvasId provided → ?canvas=<id> appended, path stays /ws", () => {
  assert.equal(gatewayWsPath(null, "fenysk-canvas-id"), "/ws?canvas=fenysk-canvas-id");
});

test("canvasId with slug → same /ws?canvas= result (slug is irrelevant for the path)", () => {
  assert.equal(gatewayWsPath("fenysk", "k97abc"), "/ws?canvas=k97abc");
});

test("canvasId absent (undefined) → bare /ws, no ?canvas= param", () => {
  assert.equal(gatewayWsPath("fenysk", undefined), "/ws");
  assert.equal(gatewayWsPath(null, undefined), "/ws");
});

test("canvasId containing URI-unsafe chars is percent-encoded", () => {
  // canvasId allowlist forbids these, but the builder should encode defensively
  const path = gatewayWsPath(null, "id with spaces");
  assert.ok(path.startsWith("/ws?canvas="), "must still use /ws");
  assert.ok(!path.includes(" "), "spaces must be encoded");
});

test("canvasId with hyphens and underscores (common Convex _id chars) passes through", () => {
  const id = "k97abc-def_123";
  assert.equal(gatewayWsPath(null, id), `/ws?canvas=${id}`);
});
