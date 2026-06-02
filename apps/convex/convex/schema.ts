/**
 * Convex durable schema for LivePlace.
 *
 * F2 (FEN-12) owns and freezes the `canvases` and `palettes` tables below
 * (cahier §6.2 / §6.3). Other durable tables (`canvasCells`, `pixelEvents`,
 * `profiles`, …) are added by their respective feature tickets; Convex schemas
 * grow additively, so adding them later is non-breaking.
 *
 * Identity (`user`, `account`, `session`, …) is managed by the Better Auth
 * Convex component in its own namespace — we do NOT declare a `users` table
 * here. `ownerId` is therefore the Better Auth user id (a string), per §6.1.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * Colour palettes. A canvas references exactly one palette. `ownerId === null`
   * marks the system default palette. `version` increments on every edit so the
   * Redis colour-cache can be invalidated (§6.3).
   */
  palettes: defineTable({
    ownerId: v.union(v.string(), v.null()),
    version: v.number(),
    colors: v.array(
      v.object({
        index: v.number(), // 0 reserved = empty/transparent
        hex: v.string(), // "#rrggbb"
      }),
    ),
  }).index("by_owner", ["ownerId"]),

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
    paletteId: v.id("palettes"),
    status: v.union(v.literal("active"), v.literal("archived")),
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
    .index("by_public_activity", ["isPublic", "status", "lastActivityAt"]),

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
    role: v.union(v.literal("user"), v.literal("moderator"), v.literal("admin")),
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
   * `lastPlacedAt`; the leaderboard (F10/FEN-21) maintains `bestRank`. The F11
   * profile read-model (FEN-22, `lib/publicProfile.ts`) reads this row.
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
    bestRank: v.optional(v.number()), // best (lowest) leaderboard rank, if computed (F10)
    lastPlacedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_canvas_user", ["canvasId", "userId"]) // point lookup + upsert
    .index("by_user", ["userId"]) // F11 profile: all canvases for a user
    .index("by_canvas_points", ["canvasId", "points"]), // F10 leaderboard ranking

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
    .index("by_user", ["userId"]), // cross-canvas audit

  /**
   * Periodic binary palette-indexed snapshots (the durable canvas source of
   * truth, ADR-0002 bin-palette-v1). The worker uploads the blob to Convex file
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
  // F8 moderation suite (FEN-52). Additive tables; the schema header pre-blesses
  // `pixelEvents` and additive growth, but per F2's freeze these still need FE
  // sign-off (coordinated on FEN-52). FEN-10 named four tables; the per-placement
  // event log it called `pixelEvents` already exists as `placements` (FEN-47,
  // author + colour + version), so moderation DERIVES "what was underneath" by
  // folding that log (lib/moderation.ts) rather than duplicating it. What was
  // genuinely missing — ban list, moderator roster, the deleted-pixel overlay
  // (CA2), and the audit trail (CA6) — is added below.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Active/lifted bans of an author on a canvas (F8.1). A ban gates whether the
   * gateway accepts the user's placements and records who/why (CA6 audit pairs
   * with `auditLog`). `active === false` is a lifted ban kept for history. The
   * wipe of their pixels is a separate dispatched action, flagged by `wiped`.
   */
  bans: defineTable({
    canvasId: v.id("canvases"),
    userId: v.string(), // banned author (Better Auth user id)
    bannedBy: v.string(), // moderator/owner who issued it
    reason: v.optional(v.string()),
    active: v.boolean(),
    wiped: v.boolean(), // true once their pixels were wiped (F8.1)
    createdAt: v.number(),
    liftedAt: v.optional(v.number()),
    liftedBy: v.optional(v.string()),
  })
    .index("by_canvas_user", ["canvasId", "userId"]) // point lookup + upsert
    .index("by_canvas_active", ["canvasId", "active"]), // list active bans

  /**
   * Moderator roster per canvas (F8.5). The owner is always implicitly a mod
   * (checked separately against `canvases.ownerId`); this table holds the
   * delegated mods. `source` distinguishes the Twitch channel-mod sync (CA5,
   * populated with no owner action) from any future manual grants. `twitchId`
   * is kept so a re-sync can reconcile by stable Twitch id across renames.
   */
  canvasModerators: defineTable({
    canvasId: v.id("canvases"),
    userId: v.optional(v.string()), // app user id once the mod has signed in
    twitchId: v.string(), // stable Twitch numeric id (sync key)
    login: v.optional(v.string()),
    displayName: v.optional(v.string()),
    source: v.union(v.literal("twitch"), v.literal("manual")),
    active: v.boolean(),
    syncedAt: v.number(),
  })
    .index("by_canvas_twitch", ["canvasId", "twitchId"]) // sync upsert key
    .index("by_canvas_user", ["canvasId", "userId"]) // authz lookup
    .index("by_canvas_active", ["canvasId", "active"]),

  /**
   * Deleted-pixel overlay (CA2): keep moderated pixels invisible on the canvas
   * but recorded in-base with author + reason. One row per moderated cell,
   * upserted by canvas+cell. `deleted === true` means the cell was wiped/deleted
   * (the live bitmap shows `revealedColor`, what was underneath); a later restore
   * flips it to `false`. `removedColor`/`removedUserId` capture what was taken
   * down so the action is fully auditable and reversible.
   */
  pixelModeration: defineTable({
    canvasId: v.id("canvases"),
    x: v.number(),
    y: v.number(),
    deleted: v.boolean(),
    removedColor: v.number(), // the colour that was taken down
    removedUserId: v.optional(v.string()), // author of the removed pixel
    revealedColor: v.number(), // colour written underneath (0 = erased)
    reason: v.optional(v.string()),
    actorUserId: v.string(), // moderator/owner who acted
    atVersion: v.number(), // write sequence at action time
    updatedAt: v.number(),
  })
    .index("by_canvas_cell", ["canvasId", "x", "y"]) // upsert + restore lookup
    .index("by_canvas_deleted", ["canvasId", "deleted"]), // list currently-hidden

  /**
   * Audit trail of every moderation action (CA6). Append-only; one row per
   * dispatched action (ban, wipe, delete, restore, freeze, unfreeze, mod sync).
   * `cellsAffected` is the size of the dispatched bulkDelta; `targetUserId` is
   * the moderated author when the action targets one.
   */
  auditLog: defineTable({
    canvasId: v.id("canvases"),
    action: v.union(
      v.literal("ban"),
      v.literal("unban"),
      v.literal("wipe"),
      v.literal("delete"),
      v.literal("restore"),
      v.literal("freeze"),
      v.literal("unfreeze"),
      v.literal("mod_sync"),
    ),
    actorUserId: v.string(), // who performed it
    targetUserId: v.optional(v.string()), // moderated author, when applicable
    cellsAffected: v.number(),
    reason: v.optional(v.string()),
    detail: v.optional(v.string()), // free-form context (e.g. dispatch result)
    createdAt: v.number(),
  }).index("by_canvas_time", ["canvasId", "createdAt"]), // newest-first per canvas
});
