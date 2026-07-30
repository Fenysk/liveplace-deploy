/**
 * Convex durable schema for LivePlace.
 *
 * F2 (FEN-12) owns and freezes the `canvases` table below (cahier §6.2).
 * Other durable tables (`canvasCells`, `pixelEvents`, `profiles`, …) are added
 * by their respective feature tickets; Convex schemas grow additively, so
 * adding them later is non-breaking.
 *
 * Identity (`user`, `account`, `session`, …) is managed by the Better Auth
 * Convex component in its own namespace — we do NOT declare a `users` table
 * here. `ownerId` is therefore the Better Auth user id (a string), per §6.1.
 */
import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// D2-R1 — Triplets constante / validator / type pour chaque enum métier
// ─────────────────────────────────────────────────────────────────────────────

export const PROFILE_ROLES = { USER: "user", MODERATOR: "moderator", ADMIN: "admin" } as const;
export const profileRoleValidator = v.union(
  v.literal(PROFILE_ROLES.USER),
  v.literal(PROFILE_ROLES.MODERATOR),
  v.literal(PROFILE_ROLES.ADMIN),
);
export type ProfileRole = Infer<typeof profileRoleValidator>;

export const CANVAS_STATUS = { ACTIVE: "active", ARCHIVED: "archived" } as const;
export const canvasStatusValidator = v.union(
  v.literal(CANVAS_STATUS.ACTIVE),
  v.literal(CANVAS_STATUS.ARCHIVED),
);
export type CanvasStatus = Infer<typeof canvasStatusValidator>;

export const AUDIT_ACTIONS = {
  BAN_WIPE: "ban_wipe",
  UNBAN: "unban",
  DELETE: "delete",
  RESTORE: "restore",
  FREEZE: "freeze",
  UNFREEZE: "unfreeze",
  MOD_SYNC: "mod_sync",
} as const;
export const auditActionValidator = v.union(
  v.literal(AUDIT_ACTIONS.BAN_WIPE),
  v.literal(AUDIT_ACTIONS.UNBAN),
  v.literal(AUDIT_ACTIONS.DELETE),
  v.literal(AUDIT_ACTIONS.RESTORE),
  v.literal(AUDIT_ACTIONS.FREEZE),
  v.literal(AUDIT_ACTIONS.UNFREEZE),
  v.literal(AUDIT_ACTIONS.MOD_SYNC),
);
export type AuditAction = Infer<typeof auditActionValidator>;

export const MOD_SOURCES = { TWITCH_SYNC: "twitch_sync", MANUAL: "manual" } as const;
export const modSourceValidator = v.union(
  v.literal(MOD_SOURCES.TWITCH_SYNC),
  v.literal(MOD_SOURCES.MANUAL),
);
export type ModSource = Infer<typeof modSourceValidator>;

export default defineSchema({
  /**
   * A canvas: one active per owner, the rest archived (read-only). Geometry is
   * frozen once the canvas has pixels (CA5). See cahier §6.2.
   */
  canvases: defineTable({
    ownerId: v.string(), // Better Auth user id (§6.1)
    slug: v.string(), // URL identifier, unique; defaults to the streamer login
    title: v.string(),
    width: v.number(),
    height: v.number(),
    status: canvasStatusValidator,
    placementOpen: v.boolean(), // false = emergency freeze (F8), independent of status
    isPublic: v.boolean(),
    eventStartAt: v.union(v.number(), v.null()),
    eventEndAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    archivedAt: v.union(v.number(), v.null()),
    lastSnapshotAt: v.union(v.number(), v.null()),
    /**
     * Denormalised count of currently non-empty cells, maintained by the durable
     * flush worker. Enables the CA5 resize guard without scanning `canvasCells`.
     * Additive F2 extension to §6.2.
     */
    cellCount: v.number(),
    /**
     * Public-gallery discovery fields (F12 / FEN-23). All OFF the hot path
     * (G-A1) and maintained by the persistence worker / gateway, NOT on pixel
     * placement — see docs/contracts/gallery-read.md.
     *
     * `lastActivityAt`: epoch ms of the most recent placement; set to `createdAt`
     * on creation so the activity sort is always well-defined, then advanced by
     * the flush worker. `viewerCount`: current live viewers, periodically flushed
     * by the gateway. `thumbnailStorageId` / `thumbnailVersion`: pointer to the
     * latest pre-rendered preview blob (the gallery never renders one on the fly,
     * G-Perf3); the worker re-renders it from a snapshot off the hot path.
     */
    lastActivityAt: v.optional(v.number()),
    viewerCount: v.optional(v.number()),
    thumbnailStorageId: v.optional(v.id("_storage")),
    thumbnailVersion: v.optional(v.number()),
  })
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_slug", ["slug"])
    .index("by_public_status", ["isPublic", "status"])
    // F12 gallery: list public+active canvases ordered by activity, paginated.
    .index("by_public_activity", ["isPublic", "status", "lastActivityAt"])
    // G6 / FEN-685: list all active canvases ordered by activity (no isPublic filter).
    .index("by_status_activity", ["status", "lastActivityAt"]),

  /**
   * Application-side projection of an authenticated user (FEN-11 / §F1).
   *
   * Identity itself (user / account / session, Twitch OAuth tokens encrypted
   * server-side) is owned by the Better Auth *component* and is NOT redefined
   * here. `profiles` is a stable app row created on first sign-in (CA1) holding
   * the Twitch identity we render and authorize against. `authUserId` equals the
   * Better Auth user id — i.e. the same value as `ownerId` elsewhere in this
   * schema and `ctx.auth.getUserIdentity().subject` (§6.1). Tokens are NEVER
   * stored here (CA3). Richer profile UI → F11; moderator sync → F8.
   */
  profiles: defineTable({
    authUserId: v.string(), // Better Auth user id (== ownerId / identity.subject)
    twitchId: v.string(), // Twitch numeric id (stable across renames)
    login: v.string(), // Twitch login slug (lowercase, may change)
    displayName: v.string(), // Twitch display name (mirrors user.name)
    avatarUrl: v.optional(v.string()), // mirrors user.image
    role: profileRoleValidator,
    createdAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_twitchId", ["twitchId"])
    // F11 public profile (FEN-22): point lookup for `/u/{login}`. The `login` is
    // stored lowercased so the index is the case-insensitive key the contract
    // (docs/contracts/profile-read.md) requires. See ADR-0001 for the lineage
    // reconciliation that froze this index into project-primary (FEN-37).
    .index("by_login", ["login"]),

  /**
   * Per-(user, canvas) progression: cumulative score, lifetime placements, and
   * the purchased gauge-max bonus. F6 (FEN-18) owns `points` / `pointsEarned` /
   * `gaugeMaxBonus`; the persistence worker (FEN-17) maintains `pixelsPlaced` /
   * `lastPlacedAt`. The F11 profile read-model (FEN-22, `lib/publicProfile.ts`)
   * reads this row.
   *
   * `points` is the *spendable* balance (earned − spent) — the value CA1/CA4
   * govern. `pointsEarned` is the monotonic lifetime total, so spending on gauge
   * upgrades never lowers a progression/leaderboard score derived from it.
   * Additive extension; Convex schemas grow additively.
   */
  userCanvasStats: defineTable({
    userId: v.string(), // Better Auth user id (§6.1)
    canvasId: v.id("canvases"),
    points: v.number(), // spendable balance (CA1: +1/colored placement, CA4: spent here)
    pointsEarned: v.number(), // lifetime points earned (never decremented)
    pixelsPlaced: v.number(), // lifetime colored placements (F11/F10)
    gaugeMaxBonus: v.number(), // permanent +max increments bought (0..cap) — F6 core
    lastPlacedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_canvas_user", ["canvasId", "userId"]) // point lookup + upsert
    .index("by_user", ["userId"]), // F11 profile: all canvases for a user

  /**
   * Durable persistence-worker side tables (FEN-17 / FEN-47, ADR-0001).
   *
   * The worker drains the Redis placement stream to Convex in idempotent batches
   * (`worker:applyFlush`), periodically writes a binary snapshot blob
   * (`worker:recordSnapshot`), and resumes from `flushState` after a restart.
   * ALL three were string-`canvasId`-keyed in the retired worker lineage; per
   * ADR-0001 (unify on the F2 canonical `canvases`) they are re-keyed to the F2
   * `id("canvases")`, resolved from the worker's WS `canvasId == slug` via
   * `canvases.by_slug`. Off the hot path: Redis stays authoritative live; Convex
   * is the durable mirror the UI reads. Additive — Convex schemas grow additively.
   */

  /**
   * Append log of placements drained from the Redis stream (audit / replay /
   * restore tail). Idempotent on (canvasId, version): a redelivered batch entry
   * is dup-skipped, so the at-least-once flush stream stays exactly-once durable
   * (R2). `version` is the canvas-monotonic global write sequence.
   */
  placements: defineTable({
    canvasId: v.id("canvases"),
    x: v.number(),
    y: v.number(),
    color: v.number(), // palette index; 0 = eraser
    version: v.number(), // global monotonic write sequence (CANVAS_WRITE_COUNTER)
    userId: v.optional(v.string()), // Better Auth user id; absent for anonymous
    ts: v.number(),
  })
    .index("by_canvas_version", ["canvasId", "version"]) // dedup + restore tail (gt)
    .index("by_user", ["userId"]) // cross-canvas audit
    // F8 (FEN-52, FE-ratified additive index): ordered per-cell history so a
    // moderation action can read "what was underneath" — most recent placement
    // at (canvasId,x,y) descending by version. See docs/contracts/moderation.md.
    .index("by_canvas_cell", ["canvasId", "x", "y", "version"]),

  /**
   * Periodic binary palette-indexed snapshots (the durable canvas source of
   * truth, ADR-0006 bin-palette-v1). The worker uploads the blob to Convex file
   * storage and records it here; on cold start it restores Redis from the latest
   * snapshot, then replays `placements` with a higher `version`.
   */
  snapshots: defineTable({
    canvasId: v.id("canvases"),
    version: v.number(), // canvas version captured
    storageId: v.id("_storage"), // bin-palette-v1 blob
    bytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_canvas", ["canvasId"]) // latest-per-canvas (order desc)
    .index("by_canvas_version", ["canvasId", "version"]),

  /**
   * Flush-worker resume cursor: the last Redis stream id acked per canvas, so a
   * restarted worker rejoins the consumer group without gaps or replays.
   */
  flushState: defineTable({
    canvasId: v.id("canvases"),
    lastStreamId: v.string(),
    lastFlushedVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_canvas", ["canvasId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // F8 moderation suite (FEN-52) — frozen by docs/contracts/moderation.md
  // (FE sign-off 2026-06-02, commit 395b6fb in the FE tree). Net delta: 3
  // additive tables below + the additive `placements.by_canvas_cell` index above.
  // The earlier draft `pixelEvents` table is dropped: "what was underneath" is
  // derived from the existing `placements` log (FEN-47) via `by_canvas_cell`,
  // with no second append log and no flush-path dual-write. Field names match the
  // frozen contract so the two divergent trees agree pending ADR-0004.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Active + historical bans of an author on a canvas (F8.1). Unban keeps the
   * row (`active === false`, `liftedAt`/`liftedBy`); it is the durable source the
   * gateway enforces (a `banned` WS error). The pixel wipe is a separate bulkDelta
   * recorded in `pixelModeration` + `auditLog`.
   */
  bans: defineTable({
    canvasId: v.id("canvases"),
    userId: v.string(), // banned author (Better Auth user id)
    bannedBy: v.string(), // moderator/owner who issued it
    reason: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
    liftedAt: v.optional(v.number()),
    liftedBy: v.optional(v.string()),
  })
    .index("by_canvas_user", ["canvasId", "userId"]) // point lookup + upsert
    .index("by_canvas_active", ["canvasId", "active"]), // list active bans

  /**
   * Moderator roster per canvas (F8.5). The owner is always implicitly a mod
   * (checked separately against `canvases.ownerId`); this holds delegated mods.
   * `source === "twitch_sync"` rows are auto-reconciled from the Twitch channel
   * mod list (CA5, no owner action); `source === "manual"` are owner-granted and
   * never touched by sync. `twitchId` is the stable re-sync key across renames.
   */
  canvasModerators: defineTable({
    canvasId: v.id("canvases"),
    userId: v.optional(v.string()), // app user id once the mod has signed in
    twitchId: v.string(), // stable Twitch numeric id (sync key)
    login: v.optional(v.string()),
    displayName: v.optional(v.string()),
    source: modSourceValidator,
    active: v.boolean(),
    syncedAt: v.number(),
  })
    .index("by_canvas_twitch", ["canvasId", "twitchId"]) // sync upsert key
    .index("by_canvas_user", ["canvasId", "userId"]) // authz lookup
    .index("by_canvas_active", ["canvasId", "active"]),

  /**
   * Overlay of moderator-removed pixels (CA2): keeps the removed pixel (author +
   * colour + reason) invisible on the canvas but recorded in-base, with restore
   * linkage (F8.3). One row per (cell, removal). The live bitmap shows
   * `underneathColor`; `modActionId` points at the `auditLog` row that removed it,
   * so a one-shot restore re-applies `removedColor` for every cell an action
   * touched (`by_modAction`). `restored` flips true on restore.
   */
  pixelModeration: defineTable({
    canvasId: v.id("canvases"),
    x: v.number(),
    y: v.number(),
    removedUserId: v.optional(v.string()), // author of the removed pixel
    removedColor: v.number(), // colour taken down (re-applied on restore)
    removedVersion: v.number(), // version of the removed placement
    underneathColor: v.number(), // colour now shown (0 = erased)
    modActionId: v.id("auditLog"), // the auditLog row that removed it
    overwriteVersion: v.optional(v.number()), // bumped version moderate.lua stamped
    reason: v.optional(v.string()),
    restored: v.boolean(),
    restoredActionId: v.optional(v.id("auditLog")), // auditLog row that restored it
    createdAt: v.number(),
  })
    .index("by_canvas_cell", ["canvasId", "x", "y"]) // CA2 lookup, list-by-cell
    .index("by_modAction", ["modActionId"]) // one-shot restore of an action
    .index("by_canvas_removedUser", ["canvasId", "removedUserId"]), // per-author audit

  /**
   * Append-only journal — one row per moderator action (CA6). Per-cell detail is
   * linked from `pixelModeration.modActionId`. `cellsAffected` is the dispatched
   * bulkDelta size; `targetUserId` is the moderated author when applicable.
   */
  auditLog: defineTable({
    canvasId: v.id("canvases"),
    action: auditActionValidator,
    actorUserId: v.string(), // who performed it
    targetUserId: v.optional(v.string()), // moderated author, when applicable
    cellsAffected: v.number(),
    reason: v.optional(v.string()),
    detail: v.optional(v.string()), // free-form context (e.g. sync diff, dispatch)
    createdAt: v.number(),
  })
    .index("by_canvas_ts", ["canvasId", "createdAt"]) // newest-first per canvas
    .index("by_actor", ["actorUserId"]), // per-moderator audit

  // ───────────────────────────────────────────────────────────────────────────
  // FEN-1868 — Twitch live-status (S1, gallery contract). Additive tables,
  // no drops (anti FEN-1818 pattern). Token never exposed in repo: internal
  // action + internal tables only.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Per-streamer live status, keyed by stable Twitch numeric id. Written
   * on transition only (isLive flips) so `updatedAt` is the last state-change
   * timestamp, not the last poll. The cron refreshes every 60s via Helix
   * Get Streams; absence/error defaults to isLive=false (A7).
   */
  streamStatus: defineTable({
    twitchId: v.string(), // stable Twitch numeric id (== profiles.twitchId)
    isLive: v.boolean(),
    startedAt: v.optional(v.number()), // epoch ms stream started; absent when not live
    updatedAt: v.number(), // epoch ms of last *transition* (not last poll)
  }).index("by_twitchId", ["twitchId"]),

  /**
   * Singleton row caching the Twitch app access token (client_credentials
   * grant). The internal action refreshes it before expiry; never read by
   * any public query or action. At most one row ever exists.
   */
  twitchAppAuth: defineTable({
    accessToken: v.string(),
    expiresAt: v.number(), // epoch ms
    updatedAt: v.number(),
  }),
});
