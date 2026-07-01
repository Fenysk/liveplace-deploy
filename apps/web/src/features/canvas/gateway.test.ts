import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayWsPath } from "./gateway.ts";

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
