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

/** Raw Twitch Helix user profile fields we read in `mapProfileToUser`. */
interface TwitchProfile {
  id?: string;
  sub?: string;
  login?: string;
  preferred_username?: string;
  display_name?: string;
  profile_image_url?: string;
}

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
    user: {
      onCreate: async (ctx, authUser) => {
        const u = authUser as typeof authUser & {
          name?: string | null;
          image?: string | null;
          twitchId?: string | null;
          login?: string | null;
        };
        await ctx.db.insert("profiles", {
          authUserId: authUser._id,
          twitchId: u.twitchId ?? "",
          login: u.login ?? "",
          displayName: u.name ?? u.login ?? "",
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
    // Surface the Twitch identifiers onto the user record so the onCreate
    // trigger can copy them into `profiles`. Not client-writable (input:false).
    user: {
      additionalFields: {
        twitchId: { type: "string", required: false, input: false },
        login: { type: "string", required: false, input: false },
      },
    },
    socialProviders: {
      twitch: {
        clientId: process.env.TWITCH_CLIENT_ID ?? "",
        clientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
        scope: [...TWITCH_SCOPES],
        mapProfileToUser: (profile: TwitchProfile) => ({
          twitchId: String(profile.id ?? profile.sub ?? ""),
          login: String(profile.login ?? profile.preferred_username ?? ""),
        }),
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
