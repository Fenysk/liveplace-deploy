import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWsTicketResolver } from "./wsTicket.ts";

test("resolves the Convex JWT only when authed (gateway gauge ungates placement) — FEN-267", async () => {
  let authed = false;
  let fetchCalls = 0;
  const resolve = makeWsTicketResolver(
    () => authed,
    async () => {
      fetchCalls++;
      return "JWT";
    },
  );

  // Anonymous: never even calls the token endpoint, resolves null.
  assert.equal(await resolve(), null);
  assert.equal(fetchCalls, 0);

  // Auth flips: the SAME bound resolver now yields the live token (read at call
  // time) — this is what the post-OAuth reconnect re-runs to leave anonymous.
  authed = true;
  assert.equal(await resolve(), "JWT");
  assert.equal(fetchCalls, 1);

  // Sign-out flips back to anonymous read-only.
  authed = false;
  assert.equal(await resolve(), null);
  assert.equal(fetchCalls, 1);
});

test("a null token (handshake not landed yet) degrades to anonymous, never throws", async () => {
  const resolve = makeWsTicketResolver(
    () => true,
    async () => null,
  );
  assert.equal(await resolve(), null);
});
