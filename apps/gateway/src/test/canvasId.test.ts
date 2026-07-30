/**
 * Contract + unit tests for canvas-id selection (S4a — FEN-1566).
 *
 * Covers:
 *   isValidCanvasId  — allowlist ^[a-zA-Z0-9_-]{1,64}$, anti-injection
 *   extractCanvasId  — ?canvas= valid → id; absent → DEFAULT_CANVAS_ID; invalid → throw
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type IncomingMessage } from "node:http";
import { isValidCanvasId, CANVAS_QUERY_PARAM } from "@canvas/protocol";
import { DEFAULT_CANVAS_ID } from "@canvas/redis-scripts";
import { extractCanvasId, CanvasIdError } from "../canvasId";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

// ── isValidCanvasId ───────────────────────────────────────────────────────────

test("isValidCanvasId: accepts the default canvas id", () => {
  assert.ok(isValidCanvasId("default"));
});

test("isValidCanvasId: accepts alphanumeric ids", () => {
  assert.ok(isValidCanvasId("fenysk"));
  assert.ok(isValidCanvasId("abc123"));
  assert.ok(isValidCanvasId("ABC"));
  assert.ok(isValidCanvasId("A0Z9"));
});

test("isValidCanvasId: accepts underscore and hyphen", () => {
  assert.ok(isValidCanvasId("canvas_1"));
  assert.ok(isValidCanvasId("canvas-1"));
  assert.ok(isValidCanvasId("my-canvas_v2"));
});

test("isValidCanvasId: accepts exactly 64 chars (upper bound)", () => {
  const id64 = "a".repeat(64);
  assert.ok(isValidCanvasId(id64));
});

test("isValidCanvasId: rejects empty string", () => {
  assert.equal(isValidCanvasId(""), false);
});

test("isValidCanvasId: rejects ids longer than 64 chars", () => {
  assert.equal(isValidCanvasId("a".repeat(65)), false);
});

test("isValidCanvasId: rejects colon (Redis key-injection vector)", () => {
  assert.equal(isValidCanvasId("canvas:pixels"), false);
  assert.equal(isValidCanvasId(":"), false);
});

test("isValidCanvasId: rejects asterisk (glob / Redis SCAN injection)", () => {
  assert.equal(isValidCanvasId("canvas*"), false);
  assert.equal(isValidCanvasId("*"), false);
});

test("isValidCanvasId: rejects spaces", () => {
  assert.equal(isValidCanvasId("canvas id"), false);
  assert.equal(isValidCanvasId(" leading"), false);
  assert.equal(isValidCanvasId("trailing "), false);
});

test("isValidCanvasId: rejects path traversal characters", () => {
  assert.equal(isValidCanvasId("../etc"), false);
  assert.equal(isValidCanvasId("canvas/other"), false);
});

test("isValidCanvasId: rejects null bytes and control characters", () => {
  assert.equal(isValidCanvasId("canvas\x00"), false);
  assert.equal(isValidCanvasId("canvas\n"), false);
});

test("isValidCanvasId: rejects dots", () => {
  assert.equal(isValidCanvasId("canvas.id"), false);
});

// ── CANVAS_QUERY_PARAM constant ───────────────────────────────────────────────

test("CANVAS_QUERY_PARAM is the string 'canvas'", () => {
  assert.equal(CANVAS_QUERY_PARAM, "canvas");
});

// ── extractCanvasId ───────────────────────────────────────────────────────────

test("extractCanvasId: valid ?canvas= → returns the id", () => {
  assert.equal(extractCanvasId(fakeReq("/ws?canvas=fenysk")), "fenysk");
});

test("extractCanvasId: valid ?canvas= with token param → returns the id", () => {
  assert.equal(extractCanvasId(fakeReq("/ws?token=jwt.tok.en&canvas=my-canvas")), "my-canvas");
  assert.equal(extractCanvasId(fakeReq("/ws?canvas=abc123&token=jwt.tok.en")), "abc123");
});

test("extractCanvasId: absent ?canvas= → DEFAULT_CANVAS_ID", () => {
  assert.equal(extractCanvasId(fakeReq("/ws")), DEFAULT_CANVAS_ID);
  assert.equal(extractCanvasId(fakeReq("/ws?token=jwt")), DEFAULT_CANVAS_ID);
});

test("extractCanvasId: absent req.url → DEFAULT_CANVAS_ID", () => {
  assert.equal(extractCanvasId(fakeReq("")), DEFAULT_CANVAS_ID);
  assert.equal(extractCanvasId({ url: undefined } as unknown as IncomingMessage), DEFAULT_CANVAS_ID);
});

test("extractCanvasId: invalid ?canvas= → throws CanvasIdError", () => {
  assert.throws(() => extractCanvasId(fakeReq("/ws?canvas=bad:id")), CanvasIdError);
  assert.throws(() => extractCanvasId(fakeReq("/ws?canvas=has space")), CanvasIdError);
  assert.throws(() => extractCanvasId(fakeReq("/ws?canvas=*")), CanvasIdError);
  assert.throws(() => extractCanvasId(fakeReq(`/ws?canvas=${"a".repeat(65)}`)), CanvasIdError);
});

test("extractCanvasId: empty ?canvas= → throws CanvasIdError (not fallback)", () => {
  assert.throws(() => extractCanvasId(fakeReq("/ws?canvas=")), CanvasIdError);
});

test("CanvasIdError has statusCode 400", () => {
  try {
    extractCanvasId(fakeReq("/ws?canvas=bad:id"));
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof CanvasIdError);
    assert.equal(err.statusCode, 400);
  }
});
