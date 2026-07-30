/**
 * Truth-table tests for resolveRenderMode (FEN-1411).
 * One test per rule + conflict combos, no browser dependencies.
 *
 * Run:
 *   node --experimental-transform-types --test \
 *     apps/web/src/features/canvas/renderMode.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRenderMode } from "./renderMode.ts";
import type { RenderModeInput } from "./renderMode.ts";

const base: RenderModeInput = {
  pathname: "/c/fenysk",
  search: "",
  userAgent: "Mozilla/5.0",
  hasObsStudio: false,
};

// ── AC5: default path ──────────────────────────────────────────────────────
test("AC5: no signals → normal", () => {
  assert.equal(resolveRenderMode(base), "normal");
});

// ── AC7: /obs route ────────────────────────────────────────────────────────
test("AC7: pathname ends /obs → obs", () => {
  assert.equal(
    resolveRenderMode({ ...base, pathname: "/c/fenysk/obs" }),
    "obs",
  );
});

test("AC7: pathname exactly /obs → obs", () => {
  assert.equal(resolveRenderMode({ ...base, pathname: "/obs" }), "obs");
});

test("AC7: pathname not ending /obs → not triggered", () => {
  // /obsidian must not match
  assert.equal(
    resolveRenderMode({ ...base, pathname: "/obsidian" }),
    "normal",
  );
});

// ── AC4: ?obs QS param ─────────────────────────────────────────────────────
test("AC4: ?obs=1 → obs", () => {
  assert.equal(resolveRenderMode({ ...base, search: "?obs=1" }), "obs");
});

test("AC4: ?obs=true → obs", () => {
  assert.equal(resolveRenderMode({ ...base, search: "?obs=true" }), "obs");
});

test("AC4: ?obs=0 → normal", () => {
  assert.equal(resolveRenderMode({ ...base, search: "?obs=0" }), "normal");
});

test("AC4: ?obs=false → normal", () => {
  assert.equal(resolveRenderMode({ ...base, search: "?obs=false" }), "normal");
});

// ── AC2: UA detection ──────────────────────────────────────────────────────
test("AC2: UA contains OBS → obs", () => {
  assert.equal(
    resolveRenderMode({ ...base, userAgent: "Mozilla/5.0 OBS/30.0" }),
    "obs",
  );
});

test("AC2: UA without OBS → not triggered", () => {
  assert.equal(
    resolveRenderMode({ ...base, userAgent: "Mozilla/5.0 Chrome/124" }),
    "normal",
  );
});

// ── AC1: hasObsStudio ──────────────────────────────────────────────────────
test("AC1: hasObsStudio=true → obs", () => {
  assert.equal(resolveRenderMode({ ...base, hasObsStudio: true }), "obs");
});

test("AC1: hasObsStudio=false → not triggered", () => {
  assert.equal(resolveRenderMode({ ...base, hasObsStudio: false }), "normal");
});

// ── Conflicts — D wins over all ────────────────────────────────────────────
test("conflict: ?obs=0 + UA OBS → normal (D beats A)", () => {
  assert.equal(
    resolveRenderMode({
      ...base,
      search: "?obs=0",
      userAgent: "Mozilla/5.0 OBS/30.0",
    }),
    "normal",
  );
});

test("conflict: ?obs=0 + hasObsStudio → normal (D beats A)", () => {
  assert.equal(
    resolveRenderMode({ ...base, search: "?obs=0", hasObsStudio: true }),
    "normal",
  );
});

test("conflict: ?obs=0 + /obs path → normal (D beats C)", () => {
  assert.equal(
    resolveRenderMode({ ...base, pathname: "/c/fenysk/obs", search: "?obs=0" }),
    "normal",
  );
});

test("conflict: ?obs=false + /obs path + UA OBS + hasObsStudio → normal (D beats all)", () => {
  assert.equal(
    resolveRenderMode({
      pathname: "/obs",
      search: "?obs=false",
      userAgent: "OBS/30.0",
      hasObsStudio: true,
    }),
    "normal",
  );
});

test("conflict: /obs path + ?obs=1 → obs (C and B agree)", () => {
  assert.equal(
    resolveRenderMode({
      ...base,
      pathname: "/c/fenysk/obs",
      search: "?obs=1",
    }),
    "obs",
  );
});

test("conflict: ?obs=1 beats UA check (B before A)", () => {
  // Both lead to obs but B is checked first — result is still obs
  assert.equal(
    resolveRenderMode({
      ...base,
      search: "?obs=1",
      userAgent: "OBS/30.0",
    }),
    "obs",
  );
});

test("conflict: UA OBS + hasObsStudio → obs (both A signals)", () => {
  assert.equal(
    resolveRenderMode({
      ...base,
      userAgent: "OBS/30.0",
      hasObsStudio: true,
    }),
    "obs",
  );
});

// ── Edge cases ─────────────────────────────────────────────────────────────
test("edge: ?obs with unknown value (e.g. obs=yes) → ignored, falls through", () => {
  // "yes" is neither 0/false/1/true — no QS rule fires
  assert.equal(resolveRenderMode({ ...base, search: "?obs=yes" }), "normal");
});

test("edge: empty search string → QS rules skip cleanly", () => {
  assert.equal(resolveRenderMode({ ...base, search: "" }), "normal");
});
