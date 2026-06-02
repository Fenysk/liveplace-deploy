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
    .index("by_twitchId", ["twitchId"]),

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
});
