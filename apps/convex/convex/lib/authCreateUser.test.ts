/**
 * Regression guard for FEN-105 / FEN-106 — Twitch login `unable_to_create_user`.
 *
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/authCreateUser.test.ts
 *
 * ## What broke (and must never come back)
 *
 * The registered `@convex-dev/better-auth` component ships a FROZEN, auto-
 * generated schema for its `user` table. Its `create` mutation validates the
 * insert `data` against a STRICT `v.object(table.validator.fields)`, which
 * rejects any key the table does not declare. The original wiring declared
 * `user.additionalFields: { twitchId, login }` and a `mapProfileToUser` that
 * returned them, so Better Auth's Twitch provider spread `{…, twitchId, login}`
 * into the create payload → `ArgumentValidationError: extra field 'twitchId'`
 * → `createUser` throws → Better Auth returns `error=unable_to_create_user` at
 * the OAuth callback (the exact symptom Alexis hit on the real round-trip).
 *
 * The fix (FEN-106) keeps the `user` create payload to component-schema fields
 * only and mirrors the Twitch id/login onto the app-owned `profiles` table via
 * the `account.onCreate` trigger. These tests pin both halves so a future edit
 * that re-introduces `additionalFields`/`mapProfileToUser` — or drops the
 * `account` backfill — fails CI instead of breaking login in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Strip block + line comments so the guards match ACTIVE CODE only — the fix's
// own comments legitimately mention `additionalFields`/`mapProfileToUser` to
// explain why they are gone, and must not trip the regression assertions.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const authCode = stripComments(
  readFileSync(fileURLToPath(new URL("../auth.ts", import.meta.url)), "utf8"),
);

test("FEN-105: auth.ts declares NO user.additionalFields (would inject extra fields into createUser)", () => {
  assert.equal(
    /additionalFields\s*:/.test(authCode),
    false,
    "user.additionalFields makes Better Auth send unknown columns to the component's strict user validator → unable_to_create_user",
  );
});

test("FEN-105: auth.ts declares NO mapProfileToUser (the source of the extra twitchId/login keys)", () => {
  assert.equal(
    /mapProfileToUser\s*:/.test(authCode),
    false,
    "mapProfileToUser returned twitchId/login, which were spread into the user create payload and rejected",
  );
});

test("FEN-106: an account.onCreate trigger backfills the Twitch identity onto profiles", () => {
  // The numeric twitchId (== account.accountId == OIDC sub) only exists once the
  // account is linked, so the backfill MUST live on the account trigger.
  const hasAccountTrigger = /account:\s*\{[\s\S]*?onCreate/.test(authCode);
  assert.ok(
    hasAccountTrigger,
    "without account.onCreate, profiles.twitchId stays empty and F8 mod-sync (moderation.ts broadcaster id) breaks",
  );
  assert.ok(
    /providerId\s*!==\s*"twitch"/.test(authCode),
    "the account trigger must guard on the Twitch provider before patching",
  );
});

// --- Validator-boundary model (documents WHY the above matters) -------------

// The columns the registered component's `user` table accepts (mirror of
// @convex-dev/better-auth/.../component/schema.ts). A strict v.object over these
// rejects anything else.
const COMPONENT_USER_FIELDS = new Set([
  "name", "email", "emailVerified", "image", "createdAt", "updatedAt",
  "twoFactorEnabled", "isAnonymous", "username", "displayUsername",
  "phoneNumber", "phoneNumberVerified", "userId",
]);

const extraFields = (data) =>
  Object.keys(data).filter((k) => !COMPONENT_USER_FIELDS.has(k));

test("the standard Twitch user payload (post-fix) carries only component fields", () => {
  // { id: sub, name: preferred_username, email, image: picture, emailVerified }
  // `id` is consumed by the adapter to derive the row id, not inserted as data.
  const fixed = {
    name: "PixelQueen",
    email: "q@example.com",
    emailVerified: true,
    image: "https://cdn.twitch.tv/a.png",
  };
  assert.deepEqual(extraFields(fixed), []);
});

test("the pre-fix payload (with twitchId/login) is exactly what the component rejected", () => {
  const broken = {
    name: "PixelQueen",
    email: "q@example.com",
    emailVerified: true,
    image: "https://cdn.twitch.tv/a.png",
    twitchId: "12345678",
    login: "pixelqueen",
  };
  assert.deepEqual(extraFields(broken).sort(), ["login", "twitchId"]);
});
