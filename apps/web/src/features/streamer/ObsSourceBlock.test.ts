/**
 * ObsSourceBlock — logic-only DoD tests (FEN-1216, Stream A).
 * Covers the pure `copyObsUrl` helper (all clipboard branches, no DOM) and
 * verifies i18n catalog completeness for the four keys the component uses.
 *
 *   node --experimental-transform-types --test \
 *     apps/web/src/features/streamer/ObsSourceBlock.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyObsUrl } from "./obsSourceBlock.ts";
import type { MessageKey } from "@canvas/i18n";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const OBS_URL = "https://liveplace.tv/my-canvas/obs";

// ── copyObsUrl ────────────────────────────────────────────────────────────────

test("copyObsUrl: clipboard.writeText succeeds → 'copied'", async () => {
  const written: string[] = [];
  const result = await copyObsUrl(OBS_URL, {
    clipboard: { writeText: async (t) => void written.push(t) },
  });
  assert.equal(result, "copied");
  assert.deepEqual(written, [OBS_URL]);
});

test("copyObsUrl: clipboard.writeText rejects → calls selectInput, returns 'failed'", async () => {
  let selected = false;
  const result = await copyObsUrl(OBS_URL, {
    clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    selectInput: () => { selected = true; },
  });
  assert.equal(result, "failed");
  assert.equal(selected, true);
});

test("copyObsUrl: no clipboard provided → calls selectInput, returns 'failed'", async () => {
  let selected = false;
  const result = await copyObsUrl(OBS_URL, {
    selectInput: () => { selected = true; },
  });
  assert.equal(result, "failed");
  assert.equal(selected, true);
});

test("copyObsUrl: never rejects — even when clipboard rejects with no selectInput", async () => {
  const result = await copyObsUrl(OBS_URL, {
    clipboard: { writeText: async () => Promise.reject(new Error("boom")) },
  });
  assert.equal(result, "failed");
});

// ── i18n catalogs ─────────────────────────────────────────────────────────────

test("catalogs: every ObsSourceBlock key exists in EN and FR", () => {
  const keys: MessageKey[] = [
    "studio.broadcast.urlLabel",
    "studio.broadcast.copy",
    "studio.broadcast.copied",
    "studio.broadcast.copyManual",
  ];
  for (const k of keys) {
    assert.ok(typeof en[k] === "string" && en[k].length > 0, `EN missing ${k}`);
    assert.ok(typeof fr[k] === "string" && fr[k].length > 0, `FR missing ${k}`);
  }
});
