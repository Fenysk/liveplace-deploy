import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeltaMessage, presenceInstanceKey, PRESENCE_KEY_PREFIX } from "../schema";

test("parses a well-formed seq,x,y,color payload", () => {
  assert.deepEqual(parseDeltaMessage("42,10,20,7"), { seq: 42, x: 10, y: 20, color: 7 });
});

test("rejects malformed payloads", () => {
  assert.equal(parseDeltaMessage("10,20,7"), null); // missing seq
  assert.equal(parseDeltaMessage("1,2,3,4,5"), null); // too many fields
  assert.equal(parseDeltaMessage("a,b,c,d"), null); // non-numeric
  assert.equal(parseDeltaMessage(""), null);
});

test("presence key is namespaced under the prefix", () => {
  assert.equal(presenceInstanceKey("nas-1234"), `${PRESENCE_KEY_PREFIX}nas-1234`);
});
