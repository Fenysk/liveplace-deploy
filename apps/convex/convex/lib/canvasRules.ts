/**
 * canvasRules — pure business rules for F2 (canvas lifecycle & config).
 *
 * This module has NO Convex imports on purpose: every rule from cahier §F2 is a
 * pure function so it can be unit-tested in isolation (see canvasRules.test.ts)
 * and reused by the gateway / placement path without pulling in the database.
 *
 * The Convex mutations in ../canvases.ts and ../palettes.ts are thin I/O wrappers
 * that call into these helpers, then read/write the durable tables.
 *
 * Spec: FEN-12 / cahier §F2. Schema: cahier §6.2 (canvases), §6.3 (palettes).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bounds & defaults (cahier §F2 "Règles").
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_DIMENSION = 16;
/**
 * Public-create ceiling. Aligned to the WS/Redis hot-path geometry
 * (`@canvas/protocol` `CANVAS_WIDTH`/`CANVAS_HEIGHT` = 512) per ADR-0004, so the
 * deployed default geometry is itself a valid `createCanvas` value and an
 * authenticated streamer can never be plafonné below what gateway/worker/Redis
 * assume. 512 is a power of two and u16-safe (the binary protocol encodes
 * width/height/x/y as u16). Keep this in lockstep with the protocol geometry.
 */
export const MAX_DIMENSION = 512;
/** Hard cap on total cells (memory/perf bound, §9.5/§10). 512×512 = 262 144. */
export const MAX_CELLS = MAX_DIMENSION * MAX_DIMENSION;
export const DEFAULT_DIMENSION = 100;

/** Palette: index 0 is reserved (empty/transparent). 2..64 colours total. */
export const MIN_PALETTE_COLORS = 2;
export const MAX_PALETTE_COLORS = 64;
export const EMPTY_COLOR_INDEX = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes. These mirror the durable schema but stay dependency-free so the
// rules can run over plain objects in tests and over Convex docs in production.
// ─────────────────────────────────────────────────────────────────────────────

export type CanvasStatus = "active" | "archived";

export interface PaletteColor {
  /** Stable slot this colour occupies; 0 is reserved empty. */
  index: number;
  /** "#RRGGBB" (lowercase, 6 hex digits). */
  hex: string;
}

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
// Validation errors. A single typed error so callers (mutations, HTTP, tests)
// can surface a clear, stable `code` to the client. CA5 requires a clear message.
// ─────────────────────────────────────────────────────────────────────────────

export type CanvasRuleCode =
  | "invalid_dimensions"
  | "invalid_palette"
  | "invalid_title"
  | "invalid_slug"
  | "invalid_event_window"
  | "resize_forbidden_non_empty"
  | "not_owner"
  | "canvas_archived";

export class CanvasRuleError extends Error {
  readonly code: CanvasRuleCode;
  constructor(code: CanvasRuleCode, message: string) {
    super(message);
    this.name = "CanvasRuleError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimensions.
// ─────────────────────────────────────────────────────────────────────────────

export function isValidDimension(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_DIMENSION && n <= MAX_DIMENSION;
}

/** Throws CanvasRuleError("invalid_dimensions") with a precise message. */
export function assertValidDimensions(width: number, height: number): void {
  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new CanvasRuleError(
      "invalid_dimensions",
      `Dimensions must be integers between ${MIN_DIMENSION}×${MIN_DIMENSION} and ` +
        `${MAX_DIMENSION}×${MAX_DIMENSION}; got ${width}×${height}.`,
    );
  }
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
    throw new CanvasRuleError("invalid_title", "Title must be 1–80 characters.");
  }
}

export function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new CanvasRuleError(
      "invalid_slug",
      "Slug must be 1–64 chars of lowercase letters, digits, or hyphens " +
        "(not starting/ending with a hyphen).",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette.
// ─────────────────────────────────────────────────────────────────────────────

const HEX_RE = /^#[0-9a-f]{6}$/;

/**
 * Validate a palette colour list. Rules (§F2/§6.3):
 *  - 2..64 colours total,
 *  - index 0 reserved (empty/transparent) and must be present,
 *  - indices are the contiguous range 0..n-1, unique,
 *  - every hex is "#rrggbb".
 */
export function assertValidPalette(colors: ReadonlyArray<PaletteColor>): void {
  const n = colors.length;
  if (n < MIN_PALETTE_COLORS || n > MAX_PALETTE_COLORS) {
    throw new CanvasRuleError(
      "invalid_palette",
      `Palette must have ${MIN_PALETTE_COLORS}–${MAX_PALETTE_COLORS} colours; got ${n}.`,
    );
  }
  const seen = new Set<number>();
  for (const c of colors) {
    if (!HEX_RE.test(c.hex)) {
      throw new CanvasRuleError(
        "invalid_palette",
        `Colour at index ${c.index} has invalid hex "${c.hex}" (expected "#rrggbb").`,
      );
    }
    if (seen.has(c.index)) {
      throw new CanvasRuleError("invalid_palette", `Duplicate palette index ${c.index}.`);
    }
    seen.add(c.index);
  }
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) {
      throw new CanvasRuleError(
        "invalid_palette",
        `Palette indices must be the contiguous range 0..${n - 1}; missing ${i}.`,
      );
    }
  }
}

/** The 16-colour system default, r/place style. Index 0 = empty (white). */
export const DEFAULT_PALETTE_COLORS: ReadonlyArray<PaletteColor> = [
  { index: 0, hex: "#ffffff" }, // empty / default
  { index: 1, hex: "#e4e4e4" },
  { index: 2, hex: "#888888" },
  { index: 3, hex: "#222222" },
  { index: 4, hex: "#ffa7d1" },
  { index: 5, hex: "#e50000" },
  { index: 6, hex: "#e59500" },
  { index: 7, hex: "#a06a42" },
  { index: 8, hex: "#e5d900" },
  { index: 9, hex: "#94e044" },
  { index: 10, hex: "#02be01" },
  { index: 11, hex: "#00d3dd" },
  { index: 12, hex: "#0083c7" },
  { index: 13, hex: "#0000ea" },
  { index: 14, hex: "#cf6ee4" },
  { index: 15, hex: "#820080" },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Event window.
// ─────────────────────────────────────────────────────────────────────────────

export function assertValidEventWindow(
  startAt: number | null,
  endAt: number | null,
): void {
  if (startAt !== null && !Number.isFinite(startAt)) {
    throw new CanvasRuleError("invalid_event_window", "eventStartAt must be epoch ms or null.");
  }
  if (endAt !== null && !Number.isFinite(endAt)) {
    throw new CanvasRuleError("invalid_event_window", "eventEndAt must be epoch ms or null.");
  }
  if (startAt !== null && endAt !== null && endAt <= startAt) {
    throw new CanvasRuleError(
      "invalid_event_window",
      "eventEndAt must be strictly after eventStartAt.",
    );
  }
}

/** True when `now` falls inside the (optionally open-ended) event window. */
export function isWithinEventWindow(canvas: Pick<CanvasShape, "eventStartAt" | "eventEndAt">, now: number): boolean {
  if (canvas.eventStartAt !== null && now < canvas.eventStartAt) return false;
  if (canvas.eventEndAt !== null && now >= canvas.eventEndAt) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resize guard (CA5). Resizing a non-empty canvas is forbidden in the MVP.
// ─────────────────────────────────────────────────────────────────────────────

export function isResize(canvas: Pick<CanvasShape, "width" | "height">, width: number, height: number): boolean {
  return canvas.width !== width || canvas.height !== height;
}

/**
 * Enforce CA5: a resize is allowed only while the canvas is still empty.
 * Throws CanvasRuleError("resize_forbidden_non_empty") with a clear message.
 */
export function assertResizeAllowed(canvas: CanvasShape, width: number, height: number): void {
  assertValidDimensions(width, height);
  if (isResize(canvas, width, height) && canvas.cellCount > 0) {
    throw new CanvasRuleError(
      "resize_forbidden_non_empty",
      `Cannot resize a canvas that already has ${canvas.cellCount} pixel(s) ` +
        `(${canvas.width}×${canvas.height} → ${width}×${height}). Create a new canvas instead (G-P4).`,
    );
  }
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
    throw new CanvasRuleError("not_owner", "Only the canvas owner may perform this action.");
  }
}

/** A palette reference carrying just the ownership column the rules below need. */
export interface PaletteOwnership {
  /** `null` = system palette (shared); otherwise the owning user's id. */
  ownerId: string | null;
}

/**
 * A canvas may *use* a palette when it is the system palette (`ownerId === null`)
 * or one the caller owns — never another user's. The single source for the check
 * `createCanvas`/`updateCanvas` both ran inline (audit 3c).
 */
export function assertPaletteUsable(palette: PaletteOwnership, userId: string): void {
  if (palette.ownerId !== null && palette.ownerId !== userId) {
    throw new CanvasRuleError("not_owner", "cannot use another user's palette.");
  }
}

/**
 * A palette may be *edited* only by its owner — the shared system palette
 * (`ownerId === null`) is immutable, and another user's is off-limits.
 */
export function assertPaletteEditable(palette: PaletteOwnership, userId: string): void {
  if (palette.ownerId !== userId) {
    throw new CanvasRuleError("not_owner", "you may only edit your own palettes.");
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
