/**
 * Better Auth + Twitch OAuth wiring for LivePlace (FEN-11 / §F1).
 *
 * Design (see docs/contracts/auth-flow.md):
 *  - Identity is owned by the Better Auth Convex *component*. The `user`,
 *    `account`, `session` and JWKS tables live there. Twitch access/refresh
 *    tokens are stored in the component, server-side and encrypted; they are
 *    NEVER returned to the browser (CA3).
 *  - On first sign-in a trigger creates the app-side `profiles` row (CA1).
 *  - `createAuth` configures the Twitch social provider with the minimal scopes
 *    (identity + moderation:read) and maps the Twitch profile onto the user.
 *  - `getTwitchAccessToken` is an INTERNAL action: server code (e.g. F8 mod
 *    sync) gets a fresh, auto-refreshed token (CA4); the browser cannot call it.
 *
 * Required Convex deployment env: SITE_URL, TWITCH_CLIENT_ID,
 * TWITCH_CLIENT_SECRET, BETTER_AUTH_SECRET, CONVEX_SITE_URL. Provided as Convex
 * env vars / Docker secrets — never committed.
 */
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import authConfig from "./auth.config";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction, internalMutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { ERRORS } from "./errors";
import { PROFILE_ROLES, CANVAS_STATUS } from "./schema";
import { parseHelixUser } from "./lib/twitchHelix";
import { personalBaseSlug } from "./lib/canvasRules";
import { refreshTwitchTokenDirect } from "./lib/twitchAuth";
import { getProfileByAuthUserId } from "./lib/profiles";
import { SITE_URL, BETTER_AUTH_URL, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from "./env";

const siteUrl = SITE_URL ?? BETTER_AUTH_URL ?? "";

/**
 * Minimal Twitch OAuth scopes (§F1 "scopes minimaux"):
 *  - user:read:email — identity (display name, login, avatar, email),
 *  - moderation:read — lets the streamer's later mod-sync (F8) read mods.
 */
export const TWITCH_SCOPES = ["user:read:email", "moderation:read"] as const;

/**
 * Backend client for the Better Auth component. The `user.onCreate` trigger is
 * how the app-side `profiles` row is created transactionally on first sign-in
 * (CA1); `onDelete` keeps it consistent if the identity is removed.
 */
// The explicit annotation breaks a type-inference cycle: `authFunctions` below
// references `internal.auth.{onCreate,…}`, whose generated types derive from
// `authComponent.triggersApi()` — i.e. from `authComponent` itself. Annotating
// the binding lets TS resolve the client type without chasing that cycle
// (otherwise TS7022: implicitly `any`, referenced in its own initializer).
export const authComponent: ReturnType<typeof createClient<DataModel>> = createClient<DataModel>(components.betterAuth, {
  triggers: {
    // CA1 — the app-side `profiles` row is created transactionally on first
    // sign-in. We deliberately DO NOT carry `twitchId`/`login` as Better Auth
    // user `additionalFields`: the @convex-dev/better-auth component ships a
    // fixed `user` table schema (name/email/image/username/…) and its `create`
    // mutation validates `data` against that strict validator — any extra field
    // is rejected, which surfaced to the browser as `?error=unable_to_create_user`
    // (FEN-106). Instead the Twitch identifiers are filled in from the `account`
    // trigger below, where they actually live (`account.accountId` == Twitch id).
    user: {
      onCreate: async (ctx, authUser) => {
        const u = authUser as typeof authUser & {
          name?: string | null;
          image?: string | null;
          // Better Auth may also carry the display name in these fields depending
          // on the provider and BA version; use the first non-empty one so a
          // profile row is never created with a blank displayName when data is
          // actually available (root cause of FEN-982 H3).
          username?: string | null;
          displayUsername?: string | null;
        };
        const displayName = u.name || u.displayUsername || u.username || "";
        await ctx.db.insert("profiles", {
          authUserId: authUser._id,
          // Backfilled by the `account.onCreate` trigger (created right after
          // the user, in the same OAuth sign-in transaction).
          twitchId: "",
          login: "",
          displayName,
          avatarUrl: u.image ?? undefined,
          role: PROFILE_ROLES.USER,
          createdAt: Date.now(),
        });
      },
      onDelete: async (ctx, authUser) => {
        const existing = await getProfileByAuthUserId(ctx.db, authUser._id);
        if (existing) await ctx.db.delete(existing._id);
      },
    },
    // The Twitch identity provider account, created immediately after the user
    // on first sign-in. `accountId` is the stable Twitch user id (the OIDC
    // `sub`); `userId` links back to the Better Auth user. We patch the matching
    // `profiles` row with the Twitch id + login slug (CA1: twitchId/login).
    account: {
      onCreate: async (ctx, account) => {
        const a = account as typeof account & {
          providerId?: string | null;
          accountId?: string | null;
          userId?: string | null;
        };
        if (a.providerId !== "twitch" || !a.userId) return;
        const profile = await getProfileByAuthUserId(ctx.db, a.userId ?? "");
        if (!profile) {
          // Profile not found: user.onCreate trigger may not have committed yet in
          // edge cases. Schedule Helix backfill anyway — it will patch once the
          // profile exists. Canvas creation is skipped (ensurePersonalCanvas in
          // CanvasViewLive is the idempotent safety-net for these users, FEN-433).
          await ctx.scheduler.runAfter(0, internal.auth.PREAUTH_backfillExactLogin, {
            authUserId: a.userId,
          });
          return;
        }
        // Twitch's OIDC id_token exposes `sub` (id) + `preferred_username`
        // (display name) but not the lowercase login slug. The login slug is
        // conventionally the display name lowercased; exact-case resolution via
        // the Helix users API is a later refinement (F8). The `/u/{login}` page
        // matches case-insensitively, so the lowercased display name is correct
        // for lookups today.
        const login = profile.login || (profile.displayName ?? "").toLowerCase();
        await ctx.db.patch(profile._id, {
          twitchId: a.accountId ?? "",
          login,
        });
        // FEN-109: the lowercased display name is only an approximation of the
        // real `login` slug (wrong for internationalised display names). Resolve
        // the exact slug asynchronously via Helix `/users` and patch it in. Best
        // effort: a fetch can't run inside this mutation, and a failure must not
        // break sign-in — `twitchId` (above) is already exact, so moderation and
        // the case-insensitive `/u/{login}` lookup stay correct meanwhile.
        await ctx.scheduler.runAfter(0, internal.auth.PREAUTH_backfillExactLogin, {
          authUserId: a.userId,
        });
        // FEN-433 (AC-1 / B1) — create personal canvas on first auth. Scheduled
        // so canvas creation is best-effort (never blocks sign-in). Idempotent.
        await ctx.scheduler.runAfter(0, internal.canvases.PREAUTH_ensurePersonalCanvas, {
          authUserId: a.userId,
        });
      },
    },
  },
  authFunctions: {
    onCreate: internal.auth.onCreate,
    onUpdate: internal.auth.onUpdate,
    onDelete: internal.auth.onDelete,
  },
});

// Registered mutations that run the trigger callbacks above in the app context.
export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/**
 * Build the Better Auth instance for a given Convex context. Called by the
 * component's HTTP routes (http.ts) and by `getAuth` for server-side API calls.
 */
export const createAuth = (
  ctx: GenericCtx<DataModel>,
  { optionsOnly }: { optionsOnly?: boolean } = {},
) =>
  betterAuth({
    baseURL: siteUrl,
    logger: { disabled: optionsOnly ?? false },
    database: authComponent.adapter(ctx),
    // Twitch is the only identity provider; link accounts to a single user.
    account: { accountLinking: { enabled: true } },
    // NOTE: no Better Auth user `additionalFields` for twitchId/login — the
    // Convex component's `user` table validator is strict and rejects unknown
    // fields (that rejection is exactly what produced `unable_to_create_user`,
    // FEN-106). The Twitch id + login are persisted onto `profiles` via the
    // `account.onCreate` trigger above. Better Auth still auto-maps the standard
    // identity fields (name ← preferred_username, image ← picture, email) from
    // the Twitch OIDC id_token, all of which ARE in the component schema.
    socialProviders: {
      twitch: {
        clientId: TWITCH_CLIENT_ID ?? "",
        clientSecret: TWITCH_CLIENT_SECRET ?? "",
        scope: [...TWITCH_SCOPES],
      },
    },
    plugins: [convex({ authConfig })],
  });

/**
 * CA4 — return a valid Twitch access token, refreshing it via the stored refresh
 * token if it has expired. INTERNAL only: tokens stay on the server (CA3).
 * Consumed by server features such as F8 moderator sync.
 *
 * Without `userId` the token resolves for the *current* request's authenticated
 * user (via session headers) — the mod-sync path, where the owner triggers it.
 * Pass `userId` to resolve a specific user's token from a context that has NO
 * session (e.g. a scheduled action — FEN-109's login backfill); Better Auth's
 * `getAccessToken` accepts `userId` server-side and skips the session lookup.
 *
 * FEN-1765 — Better Auth's `getValidAccessToken` wraps ALL refresh errors into a
 * generic FAILED_TO_GET_ACCESS_TOKEN, hiding the real Twitch API error. When the
 * Better Auth path fails, this action falls back to a *direct* Twitch refresh:
 * reads the stored refresh_token from the component's `account` table (tokens are
 * NOT encrypted — `encryptOAuthTokens` is not set), calls Twitch directly, and
 * writes the new tokens back via the component adapter. This surfaces the real
 * Twitch error (e.g. "invalid refresh token", scope mismatch) and also fixes
 * the case where Better Auth silently drops the refresh_token update.
 */
export const PREAUTH_getTwitchAccessToken = internalAction({
  args: { userId: v.optional(v.string()) },
  handler: async (
    ctx,
    { userId },
  ): Promise<{ accessToken: string | null; expiresAt: number | null }> => {
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);

    try {
      const result = (await auth.api.getAccessToken({
        body: { providerId: "twitch", ...(userId ? { userId } : {}) },
        headers,
      })) as { accessToken?: string; accessTokenExpiresAt?: Date | string | number } | null;
      return {
        accessToken: result?.accessToken ?? null,
        expiresAt: result?.accessTokenExpiresAt
          ? new Date(result.accessTokenExpiresAt).getTime()
          : null,
      };
    } catch (_baErr: unknown) {
      // Better Auth wraps the real Twitch refresh error — fall back to a direct
      // Twitch refresh so the caller sees the actual failure reason (FEN-1765).

      // Resolve the Better Auth userId needed to look up the account.
      let authUserId = userId ?? null;
      if (!authUserId) {
        const session = await auth.api.getSession({ headers }).catch(() => null) as
          | { user?: { id?: string } }
          | null;
        authUserId = session?.user?.id ?? null;
      }
      if (!authUserId) throw _baErr; // session-less context — can't fall back

      // Query the account table directly from the Better Auth component.
      // Tokens are stored in plaintext (no encryptOAuthTokens in createAuth).
      const accountPage = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "account",
        where: [
          { field: "userId", value: authUserId },
          { field: "providerId", value: "twitch" },
        ],
        paginationOpts: { cursor: null, numItems: 1 },
      })) as { page: Array<{ _id: string; refreshToken?: string | null }> };

      const account = accountPage?.page?.[0] ?? null;
      const storedRefreshToken = account?.refreshToken;
      if (!storedRefreshToken) {
        throw new ConvexError(ERRORS.TWITCH_NO_REFRESH_TOKEN);
      }

      const refreshed = await refreshTwitchTokenDirect(storedRefreshToken);

      // Write the refreshed tokens back so subsequent Better Auth calls see them.
      const now = Date.now();
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "account",
          where: [{ field: "_id", value: account._id }],
          update: {
            accessToken: refreshed.accessToken,
            ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
            accessTokenExpiresAt: refreshed.expiresAt,
            updatedAt: now,
          },
        },
      });

      return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    }
  },
});

/**
 * FEN-109 — resolve a user's exact Twitch `login` slug via Helix `GET /users`
 * and patch it onto their `profiles` row. Scheduled (best effort) from the
 * `account.onCreate` trigger on first sign-in, because the OIDC id_token only
 * carries the display name, whose lowercased form is the wrong slug for
 * internationalised names. Swallows all failures: `twitchId` is already exact,
 * so a missed backfill only leaves the approximate (lowercased) login in place.
 */
export const PREAUTH_backfillExactLogin = internalAction({
  args: { authUserId: v.string() },
  handler: async (ctx, { authUserId }): Promise<void> => {
    const clientId = TWITCH_CLIENT_ID;
    if (!clientId) return;

    let body: unknown;
    try {
      const { accessToken } = await ctx.runAction(internal.auth.PREAUTH_getTwitchAccessToken, {
        userId: authUserId,
      });
      if (!accessToken) return; // no linked Twitch token (or refresh failed)
      const res = await fetch("https://api.twitch.tv/helix/users", {
        headers: { authorization: `Bearer ${accessToken}`, "client-id": clientId },
      });
      if (!res.ok) return; // transient Helix/auth error — leave the fallback slug
      body = await res.json();
    } catch {
      return; // network/JSON error — never surface to the sign-in flow
    }

    const identity = parseHelixUser(body);
    if (!identity) return;
    await ctx.runMutation(internal.auth.PREAUTH_applyExactLogin, {
      authUserId,
      twitchId: identity.twitchId,
      login: identity.login,
      // Pass the Helix display_name so applyExactLogin can fill a blank
      // displayName (FEN-982 AC2: Helix backfill as the authoritative fix for H3).
      displayName: identity.displayName ?? "",
    });
  },
});

/**
 * FEN-109 — patch the Helix-resolved exact `login` (and backfill `twitchId` /
 * `displayName` if they were empty) onto the user's profile. Idempotent: a
 * no-op when the stored values already match, so re-running never thrashes the
 * row.
 *
 * FEN-982 AC2: also patches `displayName` when the profile has a blank one —
 * Helix `display_name` is the authoritative Twitch display name, more reliable
 * than the Better Auth `user.name` field which can be empty for some providers.
 */
export const PREAUTH_applyExactLogin = internalMutation({
  args: {
    authUserId: v.string(),
    twitchId: v.string(),
    login: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<void> => {
    if (!a.login) return;
    const profile = await getProfileByAuthUserId(ctx.db, a.authUserId);
    if (!profile) return;

    const patch: { login?: string; twitchId?: string; displayName?: string } = {};
    if (a.login !== profile.login) patch.login = a.login;
    // `twitchId` is normally set exactly by account.onCreate; only fill a gap.
    if (a.twitchId && !profile.twitchId) patch.twitchId = a.twitchId;
    // Fill a blank displayName from Helix — this is the H3 fix (FEN-982): a
    // profile whose displayName was never set (empty at user.onCreate time) is
    // permanently anonymous; Helix provides the authoritative display_name.
    if (a.displayName && !profile.displayName) patch.displayName = a.displayName;
    if (Object.keys(patch).length > 0) await ctx.db.patch(profile._id, patch);
  },
});

/**
 * Current authenticated user + app profile, or null for anonymous visitors.
 * The web client uses this to render the avatar / sign-in button and to gate
 * placement (CA5: anonymous can view but not place). No tokens are returned.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const profile = await getProfileByAuthUserId(ctx.db, user._id);
    // personalCanvasSlug follows the owner's active canvas slug so that the
    // "mon canva" button always points to whichever canvas is currently active
    // (FEN-1719). Falls back to the login-based slug when no active canvas
    // exists yet (new user before ensurePersonalCanvas runs).
    let personalCanvasSlug: string | null = null;
    if (profile?.login) {
      const activeCanvas = await ctx.db
        .query("canvases")
        .withIndex("by_owner_status", (q) =>
          q.eq("ownerId", user._id).eq("status", CANVAS_STATUS.ACTIVE),
        )
        .first();
      personalCanvasSlug =
        activeCanvas?.slug ??
        personalBaseSlug(profile.login);
    }

    return {
      id: user._id,
      name: user.name ?? null,
      image: user.image ?? null,
      profile: profile
        ? {
            login: profile.login,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl ?? null,
            role: profile.role,
          }
        : null,
      personalCanvasSlug,
    };
  },
});

