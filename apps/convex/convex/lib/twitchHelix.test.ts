/**
 * Unit tests for the Helix `/users` parser (FEN-109).
 *
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/twitchHelix.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHelixUser } from "./twitchHelix.ts";

test("extracts id, login and display_name from a well-formed body", () => {
  const body = {
    data: [
      {
        id: "141981764",
        login: "twitchdev",
        display_name: "TwitchDev",
        type: "",
        broadcaster_type: "partner",
      },
    ],
  };
  assert.deepEqual(parseHelixUser(body), {
    twitchId: "141981764",
    login: "twitchdev",
    displayName: "TwitchDev",
  });
});

test("normalises login to lowercase (defensive)", () => {
  const parsed = parseHelixUser({ data: [{ id: "1", login: "  MixedCase  ", display_name: "MixedCase" }] });
  assert.equal(parsed?.login, "mixedcase");
});

test("recovers the real login when it differs from the lowercased display name", () => {
  // The exact case FEN-109 targets: an internationalised display name whose
  // lowercase form is NOT the login slug. Helix is authoritative.
  const parsed = parseHelixUser({ data: [{ id: "9", login: "kappa_fr", display_name: "Каппа" }] });
  assert.equal(parsed?.login, "kappa_fr");
  assert.notEqual(parsed?.login, "Каппа".toLowerCase());
});

test("returns displayName undefined when missing or empty", () => {
  assert.equal(parseHelixUser({ data: [{ id: "1", login: "a" }] })?.displayName, undefined);
  assert.equal(parseHelixUser({ data: [{ id: "1", login: "a", display_name: "" }] })?.displayName, undefined);
});

test("returns empty twitchId when id is missing or non-string (login still usable)", () => {
  assert.equal(parseHelixUser({ data: [{ login: "a" }] })?.twitchId, "");
  assert.equal(parseHelixUser({ data: [{ id: 123, login: "a" }] })?.twitchId, "");
});

test("returns null on a body with no usable login", () => {
  assert.equal(parseHelixUser({ data: [{ id: "1" }] }), null);
  assert.equal(parseHelixUser({ data: [{ id: "1", login: "   " }] }), null);
  assert.equal(parseHelixUser({ data: [{ id: "1", login: 42 }] }), null);
});

test("returns null on empty / malformed envelopes without throwing", () => {
  assert.equal(parseHelixUser(null), null);
  assert.equal(parseHelixUser(undefined), null);
  assert.equal(parseHelixUser("nope"), null);
  assert.equal(parseHelixUser(42), null);
  assert.equal(parseHelixUser({}), null);
  assert.equal(parseHelixUser({ data: [] }), null);
  assert.equal(parseHelixUser({ data: "x" }), null);
});
