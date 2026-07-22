/**
 * canvasRules — pure business rules for F2 (canvas lifecycle & config).
 *
 * This module has NO Convex imports on purpose: every rule from cahier §F2 is a
 * pure function so it can be unit-tested in isolation (see canvasRules.test.ts)
 * and reused by the gateway / placement path without pulling in the database.
 *
 * Spec: FEN-12 / cahier §F2. Schema: cahier §6.2 (canvases).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bounds & defaults (cahier §F2 "Règles").
// ─────────────────────────────────────────────────────────────────────────────

/** Whitelist of allowed square canvas sizes (FEN-1720 / FEN-1712). */
export const ALLOWED_DIMENSIONS: ReadonlyArray<number> = [10, 20, 50, 100];
export const MIN_DIMENSION = 10;
/**
 * Engine ceiling — aligned to the WS/Redis hot-path geometry
 * (`@canvas/protocol` `CANVAS_WIDTH`/`CANVAS_HEIGHT` = 512) per ADR-0004.
 * This is NOT a valid `createCanvas` value; only ALLOWED_DIMENSIONS are accepted.
 * Keep in lockstep with the protocol geometry.
 */
export const MAX_DIMENSION = 512;
/** Hard cap on total cells (memory/perf bound, §9.5/§10). 512×512 = 262 144. */
export const MAX_CELLS = MAX_DIMENSION * MAX_DIMENSION;
export const DEFAULT_DIMENSION = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes. These mirror the durable schema but stay dependency-free so the
// rules can run over plain objects in tests and over Convex docs in production.
// ─────────────────────────────────────────────────────────────────────────────

import type { CanvasStatus } from "../schema";
export type { CanvasStatus };
import { ConvexError } from "convex/values";

/** The subset of a `canvases` doc the rules need to reason about. */
export interface CanvasShape {
  ownerId: string;
  width: number;
  height: number;
  status: CanvasStatus;
  placementOpen: boolean;
  eventStartAt: number | null;
  eventEndAt: number | null;
  /**
   * Denormalised count of currently non-empty cells. Maintained by the durable
   * flush worker (Redis hot path → Convex). F2 only reads it, to enforce CA5
   * (resize forbidden on a non-empty canvas) without scanning `canvasCells`.
   */
  cellCount: number;
}


// ─────────────────────────────────────────────────────────────────────────────
// Dimensions.
// ─────────────────────────────────────────────────────────────────────────────

export function isValidDimension(n: number): boolean {
  return ALLOWED_DIMENSIONS.includes(n);
}

/** Throws ConvexError("invalid_dimensions") when dimensions are not in the whitelist. */
export function assertValidDimensions(width: number, height: number): void {
  if (width !== height || !ALLOWED_DIMENSIONS.includes(width)) {
    throw new ConvexError("invalid_dimensions");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserved slugs (FEN-433 / AC-4 / FEN-2050). Single source of truth lives in
// @canvas/canvas-rules; re-exported here for back-compat with this module's
// existing callers.
// ─────────────────────────────────────────────────────────────────────────────

import { RESERVED_SLUGS, isReservedSlug as _isReservedSlug } from "@canvas/canvas-rules";
export { RESERVED_SLUGS };
export const isReservedSlug = _isReservedSlug;

/** Canonical base slug for a user's personal canvas: login as-is, or `<login>-canvas` if reserved. */
export function personalBaseSlug(login: string): string {
  return _isReservedSlug(login) ? `${login}-canvas` : login;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug & title.
// ─────────────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Normalise a free-form string into a URL slug (default: the streamer login). */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s;
}

export function assertValidTitle(title: string): void {
  const t = title.trim();
  if (t.length < 1 || t.length > 80) {
    throw new ConvexError("invalid_title");
  }
}

export function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new ConvexError("invalid_slug");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event window.
// ─────────────────────────────────────────────────────────────────────────────

export function assertValidEventWindow(
  startAt: number | null,
  endAt: number | null,
): void {
  if (startAt !== null && !Number.isFinite(startAt)) {
    throw new ConvexError("invalid_event_window");
  }
  if (endAt !== null && !Number.isFinite(endAt)) {
    throw new ConvexError("invalid_event_window");
  }
  if (startAt !== null && endAt !== null && endAt <= startAt) {
    throw new ConvexError("invalid_event_window");
  }
}

/** True when `now` falls inside the (optionally open-ended) event window. */
export function isWithinEventWindow(canvas: Pick<CanvasShape, "eventStartAt" | "eventEndAt">, now: number): boolean {
  if (canvas.eventStartAt !== null && now < canvas.eventStartAt) return false;
  if (canvas.eventEndAt !== null && now >= canvas.eventEndAt) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resize guard (CA5). Dimension whitelist + helpers for OOB confirmation logic.
// The old "shrink forbidden on non-empty" hard block is replaced by a
// confirmation flow in updateCanvasConfig (FEN-1798/C-A). assertResizeAllowed
// now only enforces the dimension whitelist.
// ─────────────────────────────────────────────────────────────────────────────

export function isResize(canvas: Pick<CanvasShape, "width" | "height">, width: number, height: number): boolean {
  return canvas.width !== width || canvas.height !== height;
}

/**
 * Enforce the dimension whitelist. The resize-on-non-empty hard block was
 * removed in FEN-1798: shrinking now triggers a confirmation flow at the
 * mutation layer (`updateCanvasConfig`) via `countOutOfBounds`.
 */
export function assertResizeAllowed(canvas: CanvasShape, width: number, height: number): void {
  assertValidDimensions(width, height);
}

/** Minimal cell descriptor used by the OOB helper (pure, no Convex deps). */
export interface LatestCell {
  x: number;
  y: number;
  color: number;
}

/**
 * Fold a flat list of placement rows into the latest color per cell.
 * Pure: operates on plain objects, no Convex deps. Used by `fetchLatestCells`,
 * `updateCanvasConfig`, and the persistence worker (3× duplication → single source).
 */
export function latestCellsFromPlacements(
  rows: ReadonlyArray<{ x: number; y: number; color: number; version: number }>,
): LatestCell[] {
  const map = new Map<string, { version: number; x: number; y: number; color: number }>();
  for (const p of rows) {
    const key = `${p.x},${p.y}`;
    const cur = map.get(key);
    if (!cur || p.version > cur.version) {
      map.set(key, { version: p.version, x: p.x, y: p.y, color: p.color });
    }
  }
  return [...map.values()];
}

/**
 * Count occupied cells (color > 0) that fall outside the new canvas bounds
 * (x >= width or y >= height). Used by `updateCanvasConfig` to decide whether
 * a shrink requires a confirmation prompt (C-A / FEN-1798).
 */
export function countOutOfBounds(
  latestCells: ReadonlyArray<LatestCell>,
  width: number,
  height: number,
): number {
  return latestCells.filter((c) => c.color > 0 && (c.x >= width || c.y >= height)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement permission (CA3 + CA4). The single source of truth for "may this
// user place a pixel on this canvas right now?". Consulted by the gateway when
// minting a place ticket and by the durable apply path.
// ─────────────────────────────────────────────────────────────────────────────

export type PlacementDenyReason =
  | "canvas_archived"
  | "banned"
  | "placement_closed"
  | "outside_event_window";

export interface PlacementDecision {
  allowed: boolean;
  reason?: PlacementDenyReason;
}

export interface PlacementContext {
  /** Is the requesting user the canvas owner? Owner may test outside the window. */
  isOwner: boolean;
  /**
   * Is the requesting user actively banned on this canvas (F8 moderation)?
   * Resolved by the caller from the durable `bans` log (`moderation.isUserBanned`)
   * — the pure rule only orders it. Defaults to false (e.g. the gateway path that
   * still gates bans separately) so existing callers are unaffected.
   */
  isBanned?: boolean;
  /** Current epoch ms. */
  now: number;
}

/**
 * Decide whether a placement is allowed. Order of checks matters for a clear
 * client message: archive (hard, even for owner) → ban → freeze → event window.
 *
 *  - CA3: archived canvas refuses ALL placement, including the owner.
 *  - F8/ban: a banned user is refused on this canvas (most relevant per-user
 *    reason, so the unified client can prevent the very first click — FEN-132).
 *  - F8/freeze: placementOpen=false refuses everyone (emergency freeze).
 *  - CA4: outside the event window, non-owners are refused; the owner may test.
 */
export function evaluatePlacement(canvas: CanvasShape, ctx: PlacementContext): PlacementDecision {
  if (canvas.status === "archived") {
    return { allowed: false, reason: "canvas_archived" };
  }
  if (ctx.isBanned) {
    return { allowed: false, reason: "banned" };
  }
  if (!canvas.placementOpen) {
    return { allowed: false, reason: "placement_closed" };
  }
  if (!ctx.isOwner && !isWithinEventWindow(canvas, ctx.now)) {
    return { allowed: false, reason: "outside_event_window" };
  }
  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle: one active canvas per owner (CA1 + CA2).
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnedCanvasRef {
  id: string;
  status: CanvasStatus;
}

/**
 * Given all of an owner's canvases, return the ids that must be archived so that
 * `targetId` becomes the *sole* active canvas. Pure decision core behind both
 * `createCanvas` (target = the new canvas) and `activateCanvas` (target = the one
 * being activated). When `targetId` is the new canvas (not yet in `owned`), pass
 * null so every currently-active canvas is demoted.
 */
export function canvasesToDemote(
  owned: ReadonlyArray<OwnedCanvasRef>,
  targetId: string | null,
): string[] {
  return owned.filter((c) => c.status === "active" && c.id !== targetId).map((c) => c.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership.
// ─────────────────────────────────────────────────────────────────────────────

export function assertOwner(canvas: Pick<CanvasShape, "ownerId">, userId: string): void {
  if (canvas.ownerId !== userId) {
    throw new ConvexError("not_owner");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal-canvas slug matching (FEN-484).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when `slug` is the personal-canvas slug derived from `baseSlug`:
 * exact match OR a uniqueSlug-style numeric suffix (`baseSlug-2`, `baseSlug-3`, …).
 * Used by ensurePersonalCanvas / ensurePersonalCanvasInternal for idempotence so
 * reserved-login users (login → baseSlug = `login-canvas`) are correctly detected.
 */
export function matchesPersonalSlug(slug: string, baseSlug: string): boolean {
  if (slug === baseSlug) return true;
  if (!slug.startsWith(baseSlug + "-")) return false;
  return /^\d+$/.test(slug.slice(baseSlug.length + 1));
}
