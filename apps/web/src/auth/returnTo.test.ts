import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POSTLOGIN_OWNCANVAS_KEY,
  sanitizeReturnTo,
  classifyOrigin,
  markPostLoginOwnCanvas,
  consumePostLoginOwnCanvas,
} from "./returnTo.ts";

// ── sessionStorage mock (Node.js has no DOM) ──────────────────────────────────
const _mockStore = new Map<string, string>();
(globalThis as Record<string, unknown>).sessionStorage = {
  getItem: (k: string) => _mockStore.get(k) ?? null,
  setItem: (k: string, v: string) => { _mockStore.set(k, v); },
  removeItem: (k: string) => { _mockStore.delete(k); },
  clear: () => { _mockStore.clear(); },
};

// ── sanitizeReturnTo ──────────────────────────────────────────────────────────

test("sanitizeReturnTo: null / undefined / empty → null", () => {
  assert.equal(sanitizeReturnTo(null), null);
  assert.equal(sanitizeReturnTo(undefined), null);
  assert.equal(sanitizeReturnTo(""), null);
});

test("sanitizeReturnTo: rejects absolute-URL schemes (AC8)", () => {
  assert.equal(sanitizeReturnTo("http://evil.com"), null);
  assert.equal(sanitizeReturnTo("https://evil.com/path"), null);
  assert.equal(sanitizeReturnTo("javascript:alert(1)"), null);
  assert.equal(sanitizeReturnTo("data:text/html,<h1>x</h1>"), null);
  assert.equal(sanitizeReturnTo("ftp://example.com"), null);
});

test("sanitizeReturnTo: rejects protocol-relative paths (AC8)", () => {
  assert.equal(sanitizeReturnTo("//evil.com"), null);
  assert.equal(sanitizeReturnTo("//evil.com/path"), null);
});

test("sanitizeReturnTo: rejects backslashes (AC8)", () => {
  assert.equal(sanitizeReturnTo("/path\\traversal"), null);
  assert.equal(sanitizeReturnTo("\\windows\\path"), null);
});

test("sanitizeReturnTo: rejects non-slash-prefixed relative paths", () => {
  assert.equal(sanitizeReturnTo("relative/path"), null);
  assert.equal(sanitizeReturnTo("./relative"), null);
  assert.equal(sanitizeReturnTo("../parent"), null);
});

test("sanitizeReturnTo: rejects unknown / 404 routes (AC8)", () => {
  assert.equal(sanitizeReturnTo("/not-a-valid-pseudo"), null); // hyphen
  assert.equal(sanitizeReturnTo("/gallery"), null); // reserved, no SPA route
  assert.equal(sanitizeReturnTo("/admin"), null);
  assert.equal(sanitizeReturnTo("/does/not/exist/deeply"), null);
});

test("sanitizeReturnTo: accepts known SPA routes", () => {
  assert.equal(sanitizeReturnTo("/"), "/");
  assert.equal(sanitizeReturnTo("/main"), "/main");
  assert.equal(sanitizeReturnTo("/alice_1"), "/alice_1");
  assert.equal(sanitizeReturnTo("/studio"), "/studio");
  assert.equal(sanitizeReturnTo("/studio/new"), "/studio/new");
  assert.equal(sanitizeReturnTo("/u/ninja"), "/u/ninja");
  assert.equal(sanitizeReturnTo("/states"), "/states");
  assert.equal(sanitizeReturnTo("/c/main"), "/c/main"); // legacy redirect
});

test("sanitizeReturnTo: accepts OBS paths as valid pages", () => {
  assert.equal(sanitizeReturnTo("/obs"), "/obs");
  assert.equal(sanitizeReturnTo("/main/obs"), "/main/obs");
});

// ── classifyOrigin ────────────────────────────────────────────────────────────

test("classifyOrigin: canvas /{pseudo} → case A (AC2/AC3)", () => {
  assert.deepEqual(classifyOrigin("/main"), { case: "A", canvasPath: "/main" });
  assert.deepEqual(classifyOrigin("/alice_1"), { case: "A", canvasPath: "/alice_1" });
  assert.deepEqual(classifyOrigin("/ninja"), { case: "A", canvasPath: "/ninja" });
});

test("classifyOrigin: /{pseudo}/obs → case A with /{pseudo} (Q5)", () => {
  assert.deepEqual(classifyOrigin("/main/obs"), { case: "A", canvasPath: "/main" });
  assert.deepEqual(classifyOrigin("/ninja/obs"), { case: "A", canvasPath: "/ninja" });
});

test("classifyOrigin: bare /obs → case B (no specific canvas)", () => {
  assert.deepEqual(classifyOrigin("/obs"), { case: "B" });
});

test("classifyOrigin: non-canvas routes → case B", () => {
  assert.deepEqual(classifyOrigin("/"), { case: "B" });
  assert.deepEqual(classifyOrigin("/studio"), { case: "B" });
  assert.deepEqual(classifyOrigin("/studio/new"), { case: "B" });
  assert.deepEqual(classifyOrigin("/u/ninja"), { case: "B" });
  assert.deepEqual(classifyOrigin("/gallery"), { case: "B" });
  assert.deepEqual(classifyOrigin("/unknown-slug"), { case: "B" }); // hyphen → notFound
});

// ── sessionStorage flag ───────────────────────────────────────────────────────

test("consumePostLoginOwnCanvas: returns false when flag is absent", () => {
  _mockStore.clear();
  assert.equal(consumePostLoginOwnCanvas(), false);
});

test("markPostLoginOwnCanvas + consumePostLoginOwnCanvas: full round-trip", () => {
  _mockStore.clear();
  markPostLoginOwnCanvas();
  assert.equal(_mockStore.get(POSTLOGIN_OWNCANVAS_KEY), "1");
  // First consume returns true and removes the flag.
  assert.equal(consumePostLoginOwnCanvas(), true);
  // Second consume returns false (already consumed).
  assert.equal(consumePostLoginOwnCanvas(), false);
  assert.equal(_mockStore.has(POSTLOGIN_OWNCANVAS_KEY), false);
});
