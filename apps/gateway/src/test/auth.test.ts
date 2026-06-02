import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { createAuthenticator, AuthError, type AuthConfig } from "../auth";

const SECRET = "test-secret-test-secret-test-secret-32";
const key = new TextEncoder().encode(SECRET);
const devCfg: AuthConfig = { devSecret: SECRET, disabled: false };

async function mint(opts: { sub?: string; expiresIn?: string } = {}): Promise<string> {
  let jwt = new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (opts.sub !== undefined) jwt = jwt.setSubject(opts.sub);
  jwt = jwt.setExpirationTime(opts.expiresIn ?? "1h");
  return jwt.sign(key);
}

test("accepts a valid token and extracts the subject (CA3)", async () => {
  const auth = createAuthenticator(devCfg);
  const token = await mint({ sub: "user-123" });
  assert.deepEqual(await auth.authenticate(token), { userId: "user-123" });
});

test("tokenless ⇒ anonymous read-only viewer (CA5/FEN-53)", async () => {
  const auth = createAuthenticator(devCfg);
  // No token presented at upgrade: admitted as anonymous (userId null), not rejected.
  assert.deepEqual(await auth.authenticate(undefined), { userId: null });
  // An empty Bearer / `?token=` is treated as no token, not as an invalid one.
  assert.deepEqual(await auth.authenticate(""), { userId: null });
});

test("present-but-invalid token ⇒ reject (no silent downgrade to anonymous)", async () => {
  const auth = createAuthenticator(devCfg);
  const bad = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-totally-different-secret-bbbbbbbbbb"));
  await assert.rejects(() => auth.authenticate(bad), AuthError);
});

test("rejects an expired token (CA3)", async () => {
  const auth = createAuthenticator(devCfg);
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setIssuedAt(0)
    .setExpirationTime(1) // epoch second 1 → long past
    .sign(key);
  await assert.rejects(() => auth.authenticate(expired), AuthError);
});

test("rejects a token signed with the wrong key (CA3)", async () => {
  const auth = createAuthenticator(devCfg);
  const bad = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-totally-different-secret-aaaaaaaaaa"));
  await assert.rejects(() => auth.authenticate(bad), AuthError);
});

test("rejects a token without a subject", async () => {
  const auth = createAuthenticator(devCfg);
  const noSub = await mint({});
  await assert.rejects(() => auth.authenticate(noSub), AuthError);
});

test("disabled mode accepts anonymous (local smoke only)", async () => {
  const auth = createAuthenticator({ disabled: true });
  assert.deepEqual(await auth.authenticate(undefined), { userId: "anon" });
});
