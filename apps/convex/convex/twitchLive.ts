/**
 * Twitch live-status refresh (FEN-1868 / S1).
 *
 * Internal action `refreshAll` — runs every 60s via crons.ts. Flow:
 *   1. Collect twitchIds of all active canvas owners (profiles join).
 *   2. Fetch/refresh app access token (client_credentials — NOT a user token).
 *   3. Batch-query Helix `GET /streams` (100 user_ids per call).
 *   4. Write `streamStatus` rows via `applyStreamStatus` — transition-only.
 *
 * Security: app token never leaves this module; stored in `twitchAppAuth`
 * (internal table, no public query). Error/absence → isLive=false (A7).
 *
 * Env vars: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET (already set for mod-sync).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { planStatusPatch } from "./lib/twitchLive";
import { getProfileByAuthUserId } from "./lib/profiles";
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from "./env";
import { CANVAS_STATUS } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// App token cache (internal reads only — never surfaced publicly).
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the cached app token if still valid for at least 5 minutes, else null. */
export const UNAUTH_getCachedAppToken = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const row = await ctx.db.query("twitchAppAuth").first();
    if (!row) return null;
    // 5-minute safety buffer so we don't use a token that's about to expire.
    if (row.expiresAt > Date.now() + 5 * 60 * 1000) return row.accessToken;
    return null;
  },
});

/** Upsert the singleton app token row. */
export const UNAUTH_saveAppToken = internalMutation({
  args: {
    accessToken: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, { accessToken, expiresAt, now }): Promise<void> => {
    const existing = await ctx.db.query("twitchAppAuth").first();
    if (existing) {
      await ctx.db.patch(existing._id, { accessToken, expiresAt, updatedAt: now });
    } else {
      await ctx.db.insert("twitchAppAuth", { accessToken, expiresAt, updatedAt: now });
    }
  },
});

/** Obtain a valid app access token, refreshing if needed. Throws on error (A7: catch at call site). */
async function getAppToken(ctx: ActionCtx): Promise<string> {
  const cached = await ctx.runQuery(internal.twitchLive.UNAUTH_getCachedAppToken, {});
  if (cached) return cached;

  const clientId = TWITCH_CLIENT_ID;
  const clientSecret = TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("twitch_credentials_unset");

  const resp = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`twitch_app_token_failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  const now = Date.now();
  await ctx.runMutation(internal.twitchLive.UNAUTH_saveAppToken, {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
    now,
  });
  return data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner discovery.
// ─────────────────────────────────────────────────────────────────────────────

/** Unique twitchIds of all active canvas owners (via profiles join). */
export const UNAUTH_getActiveOwnerTwitchIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const canvases = await ctx.db
      .query("canvases")
      .withIndex("by_status_activity", (q) => q.eq("status", CANVAS_STATUS.ACTIVE))
      .collect();

    // Phase 1: deduplicate ownerIds with no DB queries.
    const uniqueOwnerIds = [...new Set(canvases.map((c) => c.ownerId))];

    // Phase 2: resolve twitchId for each owner in parallel (N queries, N = unique owners).
    const profiles = await Promise.all(
      uniqueOwnerIds.map((ownerId) => getProfileByAuthUserId(ctx.db, ownerId)),
    );

    return profiles.flatMap((p) => (p?.twitchId ? [p.twitchId] : []));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Transition-only write.
// ─────────────────────────────────────────────────────────────────────────────

/** Apply stream status updates — writing only when isLive state changes (transition-only). */
export const UNAUTH_applyStreamStatus = internalMutation({
  args: {
    updates: v.array(
      v.object({
        twitchId: v.string(),
        isLive: v.boolean(),
        startedAt: v.optional(v.number()),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, { updates, now }): Promise<void> => {
    for (const { twitchId, isLive, startedAt } of updates) {
      const existing = await ctx.db
        .query("streamStatus")
        .withIndex("by_twitchId", (q) => q.eq("twitchId", twitchId))
        .unique();

      const patch = planStatusPatch(
        existing ? { isLive: existing.isLive, startedAt: existing.startedAt } : null,
        isLive,
        startedAt,
        now,
      );
      if (!patch) continue; // same state — no write

      if (!existing) {
        await ctx.db.insert("streamStatus", { twitchId, ...patch });
      } else {
        // replace to cleanly handle optional startedAt (patch can't delete optional fields)
        await ctx.db.replace(existing._id, { twitchId, ...patch });
      }
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron entry point.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal action called every 60s by crons.ts. Collects active-canvas owner
 * twitchIds, batches them into Helix Get Streams calls (100 ids/call), and
 * writes transitions. Any error silently degrades to twitchLive=false (A7).
 */
export const UNAUTH_refreshAll = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const clientId = TWITCH_CLIENT_ID;
    if (!clientId) return; // no credentials → degrade silently (A7)

    let accessToken: string;
    try {
      accessToken = await getAppToken(ctx);
    } catch {
      return; // token failure → degrade silently (A7)
    }

    const twitchIds = await ctx.runQuery(internal.twitchLive.UNAUTH_getActiveOwnerTwitchIds, {});
    if (twitchIds.length === 0) return;

    const liveIds = new Set<string>();
    const startedAtMap = new Map<string, number>();
    const queriedIds = new Set<string>();

    for (let i = 0; i < twitchIds.length; i += 100) {
      const batch = twitchIds.slice(i, i + 100);
      const url = new URL("https://api.twitch.tv/helix/streams");
      for (const id of batch) url.searchParams.append("user_id", id);
      url.searchParams.set("first", "100");

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "client-id": clientId,
          },
        });
      } catch {
        continue; // network error → skip batch (A7: partial failure leaves existing state)
      }

      if (!res.ok) continue; // Helix error → skip batch (A7)

      const body = (await res.json()) as {
        data?: Array<{ user_id: string; started_at: string }>;
      };

      // Mark this batch as successfully queried so we apply transitions for it.
      for (const id of batch) queriedIds.add(id);

      for (const stream of body.data ?? []) {
        liveIds.add(stream.user_id);
        const ts = new Date(stream.started_at).getTime();
        if (Number.isFinite(ts)) startedAtMap.set(stream.user_id, ts);
      }
    }

    if (queriedIds.size === 0) return;

    const updates = [...queriedIds].map((id) => ({
      twitchId: id,
      isLive: liveIds.has(id),
      ...(liveIds.has(id) && startedAtMap.has(id)
        ? { startedAt: startedAtMap.get(id) as number }
        : {}),
    }));

    await ctx.runMutation(internal.twitchLive.UNAUTH_applyStreamStatus, {
      updates,
      now: Date.now(),
    });
  },
});
