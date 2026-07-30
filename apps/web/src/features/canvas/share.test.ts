/**
 * Tests for the FEN-304 "Partager" link logic — the logic-only DoD surface for
 * the share button (the React shell is QA-verified in Étape 4).
 *   node --experimental-transform-types --test apps/web/src/features/canvas/share.test.ts
 *
 * Covers:
 *   - buildShareUrl: absolute URL for a named canvas / the default (null) canvas
 *     / a slug with characters that need percent-encoding (AC3);
 *   - copyToClipboard's three tiers (AC8): writeText OK → "copied"; writeText
 *     rejects → execCommand fallback → "copied"; both unavailable/failing →
 *     "manual"; and the guarantee that it NEVER rejects on any path;
 *   - the catalogs (FR + EN) carry a string for every share message key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareUrl, copyToClipboard } from "./share.ts";
import type { MessageKey } from "@canvas/i18n";
// Direct catalog imports (the `.ts` source, not the `@canvas/i18n` barrel) keep
// this runnable under the logic-only node runner — same pattern as
// placeState.test.ts.
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const ORIGIN = "https://liveplace.tv";

test("buildShareUrl: named canvas → absolute /:slug URL (FEN-433)", () => {
  // FEN-433: canonical form is /{slug}, not /c/{slug}
  assert.equal(buildShareUrl(ORIGIN, "mon-canvas"), `${ORIGIN}/mon-canvas`);
});

test("buildShareUrl: null slug → origin root", () => {
  assert.equal(buildShareUrl(ORIGIN, null), `${ORIGIN}/`);
});

test("buildShareUrl: slug with risky characters is percent-encoded", () => {
  // spaces / `#` / `?` must survive the round-trip the router decodes back.
  assert.equal(
    buildShareUrl(ORIGIN, "été #1?"),
    `${ORIGIN}/${encodeURIComponent("été #1?")}`,
  );
});

test("copyToClipboard: writeText succeeds → 'copied'", async () => {
  const calls: string[] = [];
  const outcome = await copyToClipboard("link", {
    clipboard: { writeText: async (t) => void calls.push(t) },
  });
  assert.equal(outcome, "copied");
  assert.deepEqual(calls, ["link"]);
});

test("copyToClipboard: writeText rejects → execCommand fallback → 'copied'", async () => {
  let execArg: string | null = null;
  const outcome = await copyToClipboard("link", {
    clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    execCommandCopy: (t) => {
      execArg = t;
      return true;
    },
  });
  assert.equal(outcome, "copied");
  assert.equal(execArg, "link");
});

test("copyToClipboard: no clipboard but execCommand works → 'copied'", async () => {
  const outcome = await copyToClipboard("link", {
    execCommandCopy: () => true,
  });
  assert.equal(outcome, "copied");
});

test("copyToClipboard: both unavailable → 'manual' (no throw)", async () => {
  const outcome = await copyToClipboard("link", {});
  assert.equal(outcome, "manual");
});

test("copyToClipboard: both fail/reject → 'manual' (never rejects)", async () => {
  const outcome = await copyToClipboard("link", {
    clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    execCommandCopy: () => false,
  });
  assert.equal(outcome, "manual");
});

test("copyToClipboard: execCommand throwing still degrades to 'manual'", async () => {
  const outcome = await copyToClipboard("link", {
    execCommandCopy: () => {
      throw new Error("boom");
    },
  });
  assert.equal(outcome, "manual");
});

test("catalogs: every share key exists in EN and FR", () => {
  const keys: MessageKey[] = [
    "canvas.share.label",
    "canvas.share.copied",
    "canvas.share.error",
    "canvas.share.aria",
  ];
  for (const k of keys) {
    assert.ok(typeof en[k] === "string" && en[k].length > 0, `EN missing ${k}`);
    assert.ok(typeof fr[k] === "string" && fr[k].length > 0, `FR missing ${k}`);
  }
});
