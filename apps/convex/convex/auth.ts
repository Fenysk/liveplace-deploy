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
import { internalAction, query } from "./_generated/server";

const siteUrl = process.env.SITE_URL ?? process.env.BETTER_AUTH_URL ?? "";

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
        };
        await ctx.db.insert("profiles", {
          authUserId: authUser._id,
          // Backfilled by the `account.onCreate` trigger (created right after
          // the user, in the same OAuth sign-in transaction).
          twitchId: "",
          login: "",
          displayName: u.name ?? "",
          avatarUrl: u.image ?? undefined,
          role: "user",
          createdAt: Date.now(),
        });
      },
      onDelete: async (ctx, authUser) => {
        const existing = await ctx.db
          .query("profiles")
          .withIndex("by_authUserId", (q) => q.eq("authUserId", authUser._id))
          .unique();
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
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_authUserId", (q) => q.eq("authUserId", a.userId ?? ""))
          .unique();
        if (!profile) return;
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
        clientId: process.env.TWITCH_CLIENT_ID ?? "",
        clientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
        scope: [...TWITCH_SCOPES],
      },
    },
    plugins: [convex({ authConfig })],
  });

/**
 * CA4 — return a valid Twitch access token for the current user, refreshing it
 * via the stored refresh token if it has expired. INTERNAL only: tokens stay on
 * the server (CA3). Consumed by server features such as F8 moderator sync.
 */
export const getTwitchAccessToken = internalAction({
  args: {},
  handler: async (ctx): Promise<{ accessToken: string | null; expiresAt: number | null }> => {
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
    const result = (await auth.api.getAccessToken({
      body: { providerId: "twitch" },
      headers,
    })) as { accessToken?: string; accessTokenExpiresAt?: Date | string | number } | null;
    return {
      accessToken: result?.accessToken ?? null,
      expiresAt: result?.accessTokenExpiresAt
        ? new Date(result.accessTokenExpiresAt).getTime()
        : null,
    };
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
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
      .unique();
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
    };
  },
});

// Exposed for the optional ClientAuthBoundary on the web side.
export const { getAuthUser } = authComponent.clientApi();
