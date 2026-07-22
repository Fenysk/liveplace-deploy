/**
 * Account deletion (FEN-1966) — contract C-4 of the FEN-1917 plan.
 *
 * `deleteMyAccount` is the ONLY public surface: an authenticated user erases
 * THEIR OWN account (zero arguments — you can never delete someone else). It is
 * idempotent and re-runnable: the identity (the only thing that lets the user
 * sign back in and retry) dies LAST, so a crash mid-purge leaves a connectable
 * account whose next call converges to the same empty state.
 *
 * Sequence (C-4):
 *   1. resolve refs (twitchId / login / canvases) BEFORE anything is deleted;
 *   2. forceFlush the concerned canvases so Redis stream entries carrying the
 *      userId drain to the durable log (best-effort, worker nudge);
 *   3. purge Redis via the gateway `POST /internal/purge-user` (§3c);
 *   4. purge the app tables in batched internal mutations (§3b) — placements
 *      on other people's canvases are ANONYMISED, never deleted (D-1 Option A,
 *      protects the from-v0 rebuild FEN-1576);
 *   5. cascade-delete the personal canvases (§3d) + a second Redis sweep;
 *   6. delete the Better Auth identity: sessions, accounts (plaintext Twitch
 *      tokens live there), best-effort verifications, then the user — whose
 *      `user.onDelete` trigger (auth.ts) deletes `profiles`; we do NOT double it.
 *
 * The per-row decisions (what is deleted vs anonymised) live as pure functions
 * in ./lib/accountPurge.ts with unit tests.
 */
import { createFunctionHandle, type FunctionArgs, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/identity";
import { forceFlush, gatewayPost } from "./lib/gateway";
import { getProfileByAuthUserId } from "./lib/profiles";
import {
  moderatorRowMatches,
  pixelModerationNeedsScrub,
  planPlacementPurge,
  scrubAuditRow,
  scrubBanRow,
} from "./lib/accountPurge";

/** Rows processed per internal-mutation call (bounds one transaction's writes). */
const BATCH = 200;
/** Page size for the index-free table scans (bans / mods / pixelMod / audit). */
const SCAN_PAGE = 400;
/**
 * Grace delay between the flush nudge and the Redis/Convex purge, giving the
 * worker time to drain `canvas:{id}:stream` entries that still carry the
 * userId. Best-effort by design (the action is re-runnable if a write races).
 */
const FLUSH_DRAIN_WAIT_MS = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — resolve every reference BEFORE deleting anything (C-4).
// ─────────────────────────────────────────────────────────────────────────────

const canvasRef = v.object({ id: v.id("canvases"), slug: v.string() });

type CanvasRef = { id: Id<"canvases">; slug: string };
type UserRefs = {
  twitchId: string | null;
  login: string | null;
  ownedCanvases: CanvasRef[];
  memberCanvases: CanvasRef[];
};

/**
 * The join keys that would be lost once deletion starts: `twitchId` (keys
 * `streamStatus` and twitch_sync moderator rows), `login` (observability), the
 * canvases the user OWNS (§3d cascade), and the canvases they joined (Redis
 * gauge/op/ban keys + flush targets). Re-run safe: an already-deleted profile
 * yields nulls, and the per-table scrubs no longer need the lost joins.
 */
export const PREAUTH_collectUserRefs = internalQuery({
  args: { userId: v.string() },
  returns: v.object({
    twitchId: v.union(v.string(), v.null()),
    login: v.union(v.string(), v.null()),
    ownedCanvases: v.array(canvasRef),
    memberCanvases: v.array(canvasRef),
  }),
  handler: async (ctx, a): Promise<UserRefs> => {
    const profile = await getProfileByAuthUserId(ctx.db, a.userId);

    const ownedRows = await ctx.db
      .query("canvases")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", a.userId))
      .collect();
    const ownedCanvases = ownedRows.map((c) => ({ id: c._id, slug: c.slug }));
    const ownedIds = new Set<string>(ownedRows.map((c) => c._id as string));

    // Canvases the user joined: one userCanvasStats row per (user, canvas) —
    // the worker upserts it on every placement, so it covers every canvas
    // holding a gauge/op key for the user.
    const stats = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_user", (q) => q.eq("userId", a.userId))
      .collect();
    const memberCanvases: CanvasRef[] = [];
    const seen = new Set<string>();
    for (const s of stats) {
      const key = s.canvasId as string;
      if (seen.has(key) || ownedIds.has(key)) continue;
      seen.add(key);
      const canvas = await ctx.db.get(s.canvasId);
      if (canvas) memberCanvases.push({ id: canvas._id, slug: canvas.slug });
    }

    return {
      twitchId: profile?.twitchId ? profile.twitchId : null,
      login: profile?.login ? profile.login : null,
      ownedCanvases,
      memberCanvases,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — batched per-table purge (§3b).
// ─────────────────────────────────────────────────────────────────────────────

/** Delete the user's per-canvas progression rows, `BATCH` at a time. */
export const PREAUTH_purgeStatsBatch = internalMutation({
  args: { userId: v.string() },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_user", (q) => q.eq("userId", a.userId))
      .take(BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH };
  },
});

/**
 * D-1 Option A: placements on other people's canvases lose their `userId`
 * (patched away — the pixel and the replay survive); rows on the user's own
 * canvases are deleted (the whole canvas dies in step 5 anyway). Every
 * processed row leaves the `by_user` index, so re-querying from the start each
 * batch always makes progress and terminates.
 */
export const PREAUTH_purgePlacementsBatch = internalMutation({
  args: { userId: v.string(), ownedCanvasIds: v.array(v.id("canvases")) },
  returns: v.object({ done: v.boolean(), canvasIds: v.array(v.id("canvases")) }),
  handler: async (ctx, a) => {
    const owned = new Set<string>(a.ownedCanvasIds as string[]);
    const rows = await ctx.db
      .query("placements")
      .withIndex("by_user", (q) => q.eq("userId", a.userId))
      .take(BATCH);
    const touched = new Set<Id<"canvases">>();
    for (const row of rows) {
      touched.add(row.canvasId);
      const op = planPlacementPurge(
        { canvasId: row.canvasId as string, userId: row.userId },
        a.userId,
        owned,
      );
      if (op === "delete") await ctx.db.delete(row._id);
      else if (op === "anonymize") await ctx.db.patch(row._id, { userId: undefined });
    }
    return { done: rows.length < BATCH, canvasIds: [...touched] };
  },
});

const scanArgs = { userId: v.string(), cursor: v.union(v.string(), v.null()) };
const scanReturns = v.object({
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * Bans have no by-user index (only per-canvas), and rows can reference the
 * user in three roles — so one paginated full-table scan handles delete
 * (banned party) + anonymise (moderator roles) in a single pass. The bans /
 * moderators / pixelModeration / audit tables are all small (they grow with
 * moderation actions, not placements).
 */
export const PREAUTH_scrubBansPage = internalMutation({
  args: scanArgs,
  returns: scanReturns,
  handler: async (ctx, a) => {
    const page: PaginationResult<Doc<"bans">> = await ctx.db
      .query("bans")
      .paginate({ cursor: a.cursor, numItems: SCAN_PAGE });
    for (const row of page.page) {
      const scrub = scrubBanRow(row, a.userId);
      if (scrub === null) continue;
      if (scrub.kind === "delete") await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, scrub.patch);
    }
    return { isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Delete moderator-roster rows naming the user (by app id or twitchId). */
export const PREAUTH_scrubModeratorsPage = internalMutation({
  args: { ...scanArgs, twitchId: v.union(v.string(), v.null()) },
  returns: scanReturns,
  handler: async (ctx, a) => {
    const page: PaginationResult<Doc<"canvasModerators">> = await ctx.db
      .query("canvasModerators")
      .paginate({ cursor: a.cursor, numItems: SCAN_PAGE });
    for (const row of page.page) {
      if (moderatorRowMatches(row, a.userId, a.twitchId)) await ctx.db.delete(row._id);
    }
    return { isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Anonymise `pixelModeration.removedUserId` (the overlay row itself survives). */
export const PREAUTH_scrubPixelModerationPage = internalMutation({
  args: scanArgs,
  returns: scanReturns,
  handler: async (ctx, a) => {
    const page: PaginationResult<Doc<"pixelModeration">> = await ctx.db
      .query("pixelModeration")
      .paginate({ cursor: a.cursor, numItems: SCAN_PAGE });
    for (const row of page.page) {
      if (pixelModerationNeedsScrub(row, a.userId)) {
        await ctx.db.patch(row._id, { removedUserId: undefined });
      }
    }
    return { isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Anonymise the audit journal (actor and/or target) — never delete it. */
export const PREAUTH_scrubAuditPage = internalMutation({
  args: scanArgs,
  returns: scanReturns,
  handler: async (ctx, a) => {
    const page: PaginationResult<Doc<"auditLog">> = await ctx.db
      .query("auditLog")
      .paginate({ cursor: a.cursor, numItems: SCAN_PAGE });
    for (const row of page.page) {
      const patch = scrubAuditRow(row, a.userId);
      if (patch !== null) await ctx.db.patch(row._id, patch);
    }
    return { isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Delete the user's live-status row (keyed by twitchId, resolved in step 1). */
export const UNAUTH_deleteStreamStatus = internalMutation({
  args: { twitchId: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("streamStatus")
      .withIndex("by_twitchId", (q) => q.eq("twitchId", a.twitchId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — personal-canvas cascade (§3d).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete one owned canvas and everything derived from it, `BATCH` rows per
 * call. Each helper below drains one table via its per-canvas index; the
 * canvases row (and its thumbnail/snapshot blobs) goes last, so a partially
 * cascaded canvas is still discoverable by `collectUserRefs` on a re-run.
 * Returns done=false while any table still had a full batch to drain.
 */
export const UNAUTH_deleteOwnedCanvasBatch = internalMutation({
  args: { canvasId: v.id("canvases") },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, a) => {
    let budget = BATCH;

    const drain = async (rows: Array<{ _id: Id<any> }>): Promise<void> => {
      for (const row of rows) await ctx.db.delete(row._id);
      budget -= rows.length;
    };

    await drain(
      await ctx.db
        .query("placements")
        .withIndex("by_canvas_version", (q) => q.eq("canvasId", a.canvasId))
        .take(budget),
    );
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("pixelModeration")
          .withIndex("by_canvas_cell", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("auditLog")
          .withIndex("by_canvas_ts", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("bans")
          .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("userCanvasStats")
          .withIndex("by_canvas_user", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("canvasModerators")
          .withIndex("by_canvas_twitch", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget > 0) {
      const snapshots = await ctx.db
        .query("snapshots")
        .withIndex("by_canvas", (q) => q.eq("canvasId", a.canvasId))
        .take(budget);
      for (const s of snapshots) {
        await ctx.storage.delete(s.storageId).catch(() => undefined);
        await ctx.db.delete(s._id);
      }
      budget -= snapshots.length;
    }
    if (budget > 0) {
      await drain(
        await ctx.db
          .query("flushState")
          .withIndex("by_canvas", (q) => q.eq("canvasId", a.canvasId))
          .take(budget),
      );
    }
    if (budget <= 0) return { done: false };

    const canvas = await ctx.db.get(a.canvasId);
    if (canvas) {
      if (canvas.thumbnailStorageId) {
        await ctx.storage.delete(canvas.thumbnailStorageId).catch(() => undefined);
      }
      await ctx.db.delete(canvas._id);
    }
    return { done: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The public action — auth, then the C-4 sequence.
// ─────────────────────────────────────────────────────────────────────────────

type AdapterDeleteManyInput = FunctionArgs<
  typeof components.betterAuth.adapter.deleteMany
>["input"];
type AdapterDeletePage = { isDone: boolean; continueCursor: string };

export const deleteMyAccount = action({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx): Promise<{ ok: boolean }> => {
    const userId = await requireUserId(ctx);

    // 1. Resolve joins before anything dies. Also snapshot the identity row
    //    (email) for the best-effort verification cleanup in step 6.
    const refs: UserRefs = await ctx.runQuery(internal.account.PREAUTH_collectUserRefs, { userId });
    const ownedIds = refs.ownedCanvases.map((c) => c.id);
    const memberIds = refs.memberCanvases.map((c) => c.id);
    const authUser = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: userId }],
    })) as { email?: string | null } | null;

    // 2. Drain the Redis streams still carrying the userId (best-effort nudge;
    //    the worker persists everything eventually regardless).
    for (const c of [...refs.memberCanvases, ...refs.ownedCanvases]) {
      await forceFlush(c.id, c.slug);
    }
    await new Promise((resolve) => setTimeout(resolve, FLUSH_DRAIN_WAIT_MS));

    // 3. Redis purge (§3c + §3d keys). Throws if the gateway rejects it — the
    //    identity is still intact at this point, so the user can just retry.
    await gatewayPost("/internal/purge-user", {
      userId,
      canvasIds: memberIds,
      ownedCanvasIds: ownedIds,
    });

    // 4. App tables (§3b), batched.
    while (!(await ctx.runMutation(internal.account.PREAUTH_purgeStatsBatch, { userId })).done);
    const extraCanvasIds = new Set<string>();
    for (;;) {
      const r = await ctx.runMutation(internal.account.PREAUTH_purgePlacementsBatch, {
        userId,
        ownedCanvasIds: ownedIds,
      });
      for (const id of r.canvasIds) extraCanvasIds.add(id as string);
      if (r.done) break;
    }
    const scanTable = async (
      run: (cursor: string | null) => Promise<{ isDone: boolean; continueCursor: string }>,
    ): Promise<void> => {
      let cursor: string | null = null;
      for (;;) {
        const page = await run(cursor);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    };
    await scanTable((cursor) => ctx.runMutation(internal.account.PREAUTH_scrubBansPage, { userId, cursor }));
    await scanTable((cursor) =>
      ctx.runMutation(internal.account.PREAUTH_scrubModeratorsPage, {
        userId,
        cursor,
        twitchId: refs.twitchId,
      }),
    );
    await scanTable((cursor) =>
      ctx.runMutation(internal.account.PREAUTH_scrubPixelModerationPage, { userId, cursor }),
    );
    await scanTable((cursor) => ctx.runMutation(internal.account.PREAUTH_scrubAuditPage, { userId, cursor }));
    if (refs.twitchId) {
      await ctx.runMutation(internal.account.UNAUTH_deleteStreamStatus, { twitchId: refs.twitchId });
    }

    // 5. Personal-canvas cascade (§3d) + a second Redis sweep: catches keys of
    //    canvases only discoverable via the placement log, and any owned-canvas
    //    key a concurrent placement resurrected between steps 3 and now.
    for (const canvasId of ownedIds) {
      while (!(await ctx.runMutation(internal.account.UNAUTH_deleteOwnedCanvasBatch, { canvasId })).done);
    }
    const known = new Set<string>([...ownedIds, ...memberIds] as string[]);
    const extras = [...extraCanvasIds].filter((id) => !known.has(id));
    if (extras.length > 0 || ownedIds.length > 0) {
      await gatewayPost("/internal/purge-user", {
        userId,
        canvasIds: extras,
        ownedCanvasIds: ownedIds,
      }).catch(() => undefined); // best-effort: step 3 already did the main sweep
    }

    // 6. Identity — LAST (C-4). Sessions, then the provider accounts holding
    //    the plaintext Twitch tokens, then best-effort verifications, then the
    //    user row; its `user.onDelete` trigger deletes `profiles` (auth.ts) so
    //    we deliberately do not touch that table here.
    const adapterDeleteMany = async (input: AdapterDeleteManyInput): Promise<void> => {
      let cursor: string | null = null;
      for (;;) {
        const page = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
          input,
          paginationOpts: { cursor, numItems: BATCH },
        })) as AdapterDeletePage;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    };
    await adapterDeleteMany({ model: "session", where: [{ field: "userId", value: userId }] });
    await adapterDeleteMany({ model: "account", where: [{ field: "userId", value: userId }] });
    if (authUser?.email) {
      await adapterDeleteMany({
        model: "verification",
        where: [{ field: "identifier", value: authUser.email }],
      }).catch(() => undefined); // best-effort: short-TTL rows, identifier formats vary
    }
    const onDeleteHandle = await createFunctionHandle(internal.auth.onDelete);
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "user", where: [{ field: "_id", value: userId }] },
      onDeleteHandle,
    });

    return { ok: true };
  },
});
