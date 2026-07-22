/**
 * FEN-1737 / FEN-1765 — one-shot DevOps diagnostics (Helix token probe,
 * diag result readback). Extracted from moderation.ts (B2 refacto FEN-1951)
 * to keep that module under ~800 l. These are internalQuery / internalAction
 * only — no public API surface.
 *
 * worker:run callers:
 *   fn="diagnoseTwitchToken" args={userId:"<auth-id>"|twitchLogin:"<login>",forceExpire?:true}
 *   fn="lookupProfileByLogin" args={login:"<login>"}
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { getProfileByAuthUserId } from "./lib/profiles";
import { TWITCH_CLIENT_ID } from "./env";

/** Look up a user's profile (authUserId + twitchId) by Better Auth user id. */
export const PREAUTH_lookupProfileByUserId = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.object({ authUserId: v.string(), twitchId: v.string() }), v.null()),
  handler: async (ctx, { userId }) => {
    const profile = await getProfileByAuthUserId(ctx.db, userId);
    if (!profile) return null;
    return { authUserId: profile.authUserId, twitchId: profile.twitchId };
  },
});

/** Look up a user's profile (authUserId + twitchId) by Twitch login slug. */
export const UNAUTH_lookupProfileByLogin = internalQuery({
  args: { login: v.string() },
  returns: v.union(v.object({ authUserId: v.string(), twitchId: v.string() }), v.null()),
  handler: async (ctx, { login }) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_login", (q) => q.eq("login", login.toLowerCase()))
      .unique();
    if (!profile) return null;
    return { authUserId: profile.authUserId, twitchId: profile.twitchId };
  },
});

/**
 * FEN-1737 — read a user's token directly from storage (bypasses session/ctx
 * identity), call Helix /moderation/moderators, return the raw status+body.
 * Distinguishes a 403 scope gap (reconnect) from a config bug (agent-fixable).
 *
 * Pass EITHER userId (Better Auth id) OR twitchLogin (e.g. "fenysk").
 * Callable via worker:run fn="diagnoseTwitchToken"
 *   args={userId:"<auth-id>"}       — if you have the Better Auth user id
 *   args={twitchLogin:"fenysk"}     — if you only have the Twitch login
 *
 * FEN-1765 — add forceExpire: true to simulate expiration BEFORE the check.
 * This lets DevOps prove the FEN-1765 fallback refresh works without waiting
 * 4h for the real token to expire:
 *   args={twitchLogin:"fenysk",forceExpire:true}
 * Sets accessTokenExpiresAt=0 on the account, then immediately calls
 * getTwitchAccessToken (which hits the fallback) and reports the result.
 */
export const UNAUTH_diagnoseTwitchToken = internalAction({
  args: {
    userId: v.optional(v.string()),
    twitchLogin: v.optional(v.string()),
    forceExpire: v.optional(v.boolean()),
  },
  returns: v.object({
    resolvedUserId: v.union(v.string(), v.null()),
    tokenPresent: v.boolean(),
    accessTokenExpiresAt: v.union(v.number(), v.null()),
    broadcasterId: v.union(v.string(), v.null()),
    clientIdPresent: v.boolean(),
    helixStatus: v.union(v.number(), v.null()),
    helixBody: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args: { userId?: string; twitchLogin?: string; forceExpire?: boolean },
  ): Promise<{
    resolvedUserId: string | null;
    tokenPresent: boolean;
    accessTokenExpiresAt: number | null;
    broadcasterId: string | null;
    clientIdPresent: boolean;
    helixStatus: number | null;
    helixBody: string | null;
  }> => {
    let resolvedUserId: string | null = args.userId ?? null;
    let broadcasterId: string | null = null;

    if (resolvedUserId) {
      const profile: { authUserId: string; twitchId: string } | null = await ctx.runQuery(
        internal.moderationDiag.PREAUTH_lookupProfileByUserId,
        { userId: resolvedUserId },
      );
      broadcasterId = profile?.twitchId || null;
    } else if (args.twitchLogin) {
      const profile: { authUserId: string; twitchId: string } | null = await ctx.runQuery(
        internal.moderationDiag.UNAUTH_lookupProfileByLogin,
        { login: args.twitchLogin },
      );
      resolvedUserId = profile?.authUserId ?? null;
      broadcasterId = profile?.twitchId || null;
    }

    if (!resolvedUserId) {
      return {
        resolvedUserId: null,
        tokenPresent: false,
        accessTokenExpiresAt: null,
        broadcasterId: null,
        clientIdPresent: !!TWITCH_CLIENT_ID,
        helixStatus: null,
        helixBody: "profile_not_found: no profile matched userId/twitchLogin",
      };
    }

    // FEN-1765: simulate expiration so the fallback refresh path can be proven
    // in prod without waiting for the real 4h TTL. Sets accessTokenExpiresAt=0
    // so Better Auth's getValidAccessToken detects expiry and attempts refresh
    // (which then hits the new FEN-1765 fallback when Better Auth's own refresh
    // fails with the generic error).
    if (args.forceExpire) {
      const accountPage = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "account",
        where: [
          { field: "userId", value: resolvedUserId },
          { field: "providerId", value: "twitch" },
        ],
        paginationOpts: { cursor: null, numItems: 1 },
      })) as { page: Array<{ _id: string }> };
      const acct = accountPage?.page?.[0];
      if (acct) {
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: "account",
            where: [{ field: "_id", value: acct._id }],
            update: { accessTokenExpiresAt: 0, updatedAt: Date.now() },
          },
        });
      }
    }

    let accessToken: string | null = null;
    let expiresAt: number | null = null;
    try {
      const tokenResult: { accessToken: string | null; expiresAt: number | null } =
        await ctx.runAction(internal.auth.PREAUTH_getTwitchAccessToken, { userId: resolvedUserId });
      accessToken = tokenResult.accessToken;
      expiresAt = tokenResult.expiresAt;
    } catch (err: unknown) {
      // Better Auth APIError: serialize status + body so the caller can read the exact reason
      const apiErr = err as { status?: number; body?: unknown; message?: string };
      const detail =
        apiErr.body != null
          ? JSON.stringify(apiErr.body)
          : (apiErr.message ?? String(err));
      return {
        resolvedUserId,
        tokenPresent: false,
        accessTokenExpiresAt: null,
        broadcasterId,
        clientIdPresent: !!TWITCH_CLIENT_ID,
        helixStatus: typeof apiErr.status === "number" ? apiErr.status : null,
        helixBody: `token_error: ${detail}`,
      };
    }

    const clientId: string | undefined = TWITCH_CLIENT_ID;

    if (!accessToken || !broadcasterId || !clientId) {
      return {
        resolvedUserId,
        tokenPresent: !!accessToken,
        accessTokenExpiresAt: expiresAt,
        broadcasterId,
        clientIdPresent: !!clientId,
        helixStatus: null,
        helixBody: null,
      };
    }

    const url = new URL("https://api.twitch.tv/helix/moderation/moderators");
    url.searchParams.set("broadcaster_id", broadcasterId);
    url.searchParams.set("first", "1");
    let helixStatus: number | null = null;
    let helixBody: string | null = null;
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, "client-id": clientId },
      });
      helixStatus = res.status;
      helixBody = await res.text().catch(() => "");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      helixBody = `helix_fetch_error: ${msg}`;
    }

    return {
      resolvedUserId,
      tokenPresent: true,
      accessTokenExpiresAt: expiresAt,
      broadcasterId,
      clientIdPresent: true,
      helixStatus,
      helixBody,
    };
  },
});

