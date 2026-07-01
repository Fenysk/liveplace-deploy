import { test } from "node:test";
import assert from "node:assert/strict";
import { errorKeyFromParam } from "./useAuthErrorToast.ts";

test("errorKeyFromParam: null → null", () => {
  assert.equal(errorKeyFromParam(null), null);
});

test("errorKeyFromParam: empty string → null", () => {
  assert.equal(errorKeyFromParam(""), null);
});

test("errorKeyFromParam: access_denied → cancelled (user cancelled OAuth)", () => {
  assert.equal(errorKeyFromParam("access_denied"), "auth.error.cancelled");
});

test("errorKeyFromParam: any other error code → failed", () => {
  assert.equal(errorKeyFromParam("server_error"), "auth.error.failed");
  assert.equal(errorKeyFromParam("temporarily_unavailable"), "auth.error.failed");
  assert.equal(errorKeyFromParam("invalid_request"), "auth.error.failed");
  assert.equal(errorKeyFromParam("unknown"), "auth.error.failed");
});
