/**
 * Tests for resolvePostLoginOwnCanvas (returnTo.ts / S2 resolver — FEN-1472).
 * The pure resolver is separated from the React hook (usePostLoginRedirect.ts)
 * so it can run under the Node.js test runner without browser dependencies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePostLoginOwnCanvas } from "./returnTo.ts";

const SESSION = { user: { name: "Alice" } };

// ── noop ──────────────────────────────────────────────────────────────────────

test("noop: flag not consumed → noop regardless of session/me state", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: false,
      session: SESSION,
      isPending: false,
      me: { personalCanvasSlug: "alice" },
    }),
    { kind: "noop" },
  );
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: false,
      session: null,
      isPending: true,
      me: undefined,
    }),
    { kind: "noop" },
  );
});

test("noop: flag consumed but session settled as anonymous", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: null,
      isPending: false,
      me: undefined,
    }),
    { kind: "noop" },
  );
});

// ── pending ───────────────────────────────────────────────────────────────────

test("pending: flag consumed, session still resolving (isPending=true)", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: null,
      isPending: true,
      me: undefined,
    }),
    { kind: "pending" },
  );
});

test("pending: flag consumed, session authed, me query still loading", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: SESSION,
      isPending: false,
      me: undefined,
    }),
    { kind: "pending" },
  );
});

// ── redirect ──────────────────────────────────────────────────────────────────

test("redirect: flag consumed, authed, me settled with slug → /slug (AC5)", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: SESSION,
      isPending: false,
      me: { personalCanvasSlug: "alice" },
    }),
    { kind: "redirect", path: "/alice" },
  );
});

test("redirect: slug with underscore is preserved by paths.canvas", () => {
  const v = resolvePostLoginOwnCanvas({
    flagConsumed: true,
    session: SESSION,
    isPending: false,
    me: { personalCanvasSlug: "alice_1" },
  });
  assert.equal(v.kind, "redirect");
  if (v.kind === "redirect") assert.equal(v.path, "/alice_1");
});

// ── fallback (Q3) ─────────────────────────────────────────────────────────────

test("fallback: flag consumed, authed, me settled with null slug (Q3)", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: SESSION,
      isPending: false,
      me: { personalCanvasSlug: null },
    }),
    { kind: "fallback" },
  );
});

test("fallback: flag consumed, authed, me settled as null (Convex transient)", () => {
  assert.deepEqual(
    resolvePostLoginOwnCanvas({
      flagConsumed: true,
      session: SESSION,
      isPending: false,
      me: null,
    }),
    { kind: "fallback" },
  );
});
