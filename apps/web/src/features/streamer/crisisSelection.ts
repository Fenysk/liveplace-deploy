/**
 * Crisis ban/wipe/restore selection logic — pure, headless ([FEN-160], builds
 * FEN-157 §2 ban / §3 wipe / §4 restore). Like {@link buildCrisisPanel}, this is
 * React- and Convex-free so the whole selection/confirm/restore decision logic
 * unit-tests headlessly (the web `test` script is logic-only). The thin React
 * surfaces (reticle, marquee, undo list) and the Convex host wire to these
 * descriptors; i18n keys are RETURNED, never resolved here.
 *
 * Three flows, one module:
 *   - Ban (§2): aim a reticle at a pixel → resolve its author (`authorAt`) →
 *     blast-radius confirm → `banAndWipe`. Empty/protected/error/cancel states.
 *   - Wipe (§3): drag a rectangle marquee → live cell count (client geometry) →
 *     large-region soft warning → confirm → `deletePixels`. Empty/error/cancel.
 *   - Restore (§4): project `listAuditLog` rows onto an "Actions récentes" undo
 *     list (filtered to reversible removals) → overwrite-forewarning confirm →
 *     `restore`.
 *
 * Destructive-action discipline (Norman / spec §1): every removal names its blast
 * radius before commit, every step is abandonable in one gesture (Escape/Annuler),
 * and the post-dispatch render distinguishes a CLEAN success (pixels overwritten
 * on the live canvas) from the `gateway_not_configured` caveat (durable +
 * restorable, but NOT yet on the live canvas) — the latter must never render as a
 * green clean-success (false-safety signal, spec §2 Flow A).
 */
import type { MessageKey } from "@canvas/i18n";

/** An i18n key + its interpolation params — resolved by the React layer via `t`. */
export interface CrisisAnnounce {
  key: MessageKey;
  params?: Record<string, string | number>;
  /** Live-region politeness: errors are assertive (`alert`), everything else polite (`status`). */
  role: "status" | "alert";
}

const status = (key: MessageKey, params?: Record<string, string | number>): CrisisAnnounce => ({
  key,
  params,
  role: "status",
});
const alert = (key: MessageKey, params?: Record<string, string | number>): CrisisAnnounce => ({
  key,
  params,
  role: "alert",
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — marquee → cells (client-side, no backend round-trip, spec §3.2).
// ─────────────────────────────────────────────────────────────────────────────

export interface CellCoord {
  x: number;
  y: number;
}

export interface CanvasBounds {
  width: number;
  height: number;
}

/** Soft "large wipe" warning thresholds (spec §3 edge path; both client-side). */
export const WIPE_WARN_THRESHOLD = 1000;
export const WIPE_WARN_FRACTION = 0.25;

/** Inclusive rectangle corners → clamped integer bounds `[x0..x1] × [y0..y1]`. */
function clampedRect(a: CellCoord, b: CellCoord, bounds: CanvasBounds): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const x0 = Math.max(0, Math.min(Math.floor(a.x), Math.floor(b.x)));
  const y0 = Math.max(0, Math.min(Math.floor(a.y), Math.floor(b.y)));
  const x1 = Math.min(bounds.width - 1, Math.max(Math.floor(a.x), Math.floor(b.x)));
  const y1 = Math.min(bounds.height - 1, Math.max(Math.floor(a.y), Math.floor(b.y)));
  return { x0, y0, x1, y1 };
}

/**
 * The set of cells covered by a marquee from corner `a` to corner `b`, clamped to
 * `[0,width) × [0,height)` (spec §3 "region partly outside bounds → clamp"). The
 * `deletePixels` `cells` payload. Returns `[]` for a degenerate/out-of-bounds box.
 */
export function rectCells(a: CellCoord, b: CellCoord, bounds: CanvasBounds): CellCoord[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const { x0, y0, x1, y1 } = clampedRect(a, b, bounds);
  if (x1 < x0 || y1 < y0) return [];
  const cells: CellCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.push({ x, y });
  }
  return cells;
}

/** Cell count of the clamped marquee — cheap (no array alloc) for the live readout. */
export function rectCellCount(a: CellCoord, b: CellCoord, bounds: CanvasBounds): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 0;
  const { x0, y0, x1, y1 } = clampedRect(a, b, bounds);
  if (x1 < x0 || y1 < y0) return 0;
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/**
 * The clamped marquee's PERIMETER cells only (O(w+h), not O(w·h)) — the renderer
 * overlay draws this outline as the live marquee so a 5000-cell region never
 * pushes 5000 overlay rects per hover frame (frame-budget discipline; the full
 * `cells` payload is built once at finalize via {@link rectCells}).
 */
export function rectOutlineCells(a: CellCoord, b: CellCoord, bounds: CanvasBounds): CellCoord[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const { x0, y0, x1, y1 } = clampedRect(a, b, bounds);
  if (x1 < x0 || y1 < y0) return [];
  const out: CellCoord[] = [];
  for (let x = x0; x <= x1; x++) {
    out.push({ x, y: y0 });
    if (y1 !== y0) out.push({ x, y: y1 });
  }
  for (let y = y0 + 1; y < y1; y++) {
    out.push({ x: x0, y });
    if (x1 !== x0) out.push({ x: x1, y });
  }
  return out;
}

/**
 * Whether a wipe of `count` cells trips the large-region soft warning: fixed floor
 * OR a fraction of the whole canvas, whichever fires first (spec §3 — the OR with
 * 25% catches a small canvas where 1000 cells *is* most of it). Soft, never a hard
 * block — the warning only makes magnitude legible.
 */
export function wipeIsLarge(count: number, bounds: CanvasBounds): boolean {
  if (count <= 0) return false;
  if (count > WIPE_WARN_THRESHOLD) return true;
  const area = Math.max(0, bounds.width) * Math.max(0, bounds.height);
  return area > 0 && count >= WIPE_WARN_FRACTION * area;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ban flow (§2) — author resolution → confirm.
// ─────────────────────────────────────────────────────────────────────────────

export interface BanTarget {
  userId: string;
  displayName?: string;
}

/** Mode banner announced once on entering ban-select (spec §2.1, `role=status`). */
export function banModeBanner(): CrisisAnnounce {
  return status("studio.crisis.ban.mode");
}

/** Mode banner announced once on entering wipe-select (spec §3.1). */
export function wipeModeBanner(): CrisisAnnounce {
  return status("studio.crisis.wipe.mode");
}

/** The result of resolving the author under the reticle (`authorAt` + target guard). */
export type BanPickOutcome =
  | { kind: "empty"; announce: CrisisAnnounce }
  | { kind: "protected"; announce: CrisisAnnounce }
  | { kind: "confirm"; target: BanTarget };

/**
 * Turn a resolved `authorAt` result into the next ban step (spec §2.3–2.4 + edge
 * paths). `null` author → empty-cell hint (stay in select-mode); a protected
 * target (owner/active moderator, soft-guarded client-side via `listModerators`)
 * → blocked with reason; otherwise advance to the blast-radius confirm.
 */
export function resolveBanPick(author: BanTarget | null, isProtectedTarget: boolean): BanPickOutcome {
  if (!author) return { kind: "empty", announce: status("studio.crisis.ban.empty") };
  if (isProtectedTarget) return { kind: "protected", announce: status("studio.crisis.ban.protected") };
  return { kind: "confirm", target: author };
}

export interface BanConfirmView {
  /** "Bannir {author} et retirer tous ses pixels ?" — `{author}` = name or anon fallback. */
  title: CrisisAnnounce;
  /** "{count} pixels seront retirés." — null when the blast-radius preview is unavailable (§2.4 fallback). */
  count: CrisisAnnounce | null;
}

/**
 * Blast-radius confirm copy (spec §2.4). `blastRadius` is the optional
 * `banBlastRadius` preview; when absent the confirm falls back to "tous ses pixels"
 * (title only, no count line). The author param falls back to a localized
 * "{displayName|auteur}" anon label when the profile has no display name.
 */
export function banConfirmView(
  target: BanTarget,
  blastRadius: number | null,
  anonLabel: string,
): BanConfirmView {
  return {
    title: status("studio.crisis.ban.confirm", { author: target.displayName ?? anonLabel }),
    count:
      blastRadius != null && blastRadius >= 0
        ? status("studio.crisis.ban.confirmCount", { count: blastRadius })
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wipe flow (§3) — live count → confirm.
// ─────────────────────────────────────────────────────────────────────────────

/** Live "Zone : {count} cellules" readout while the marquee grows (spec §3.2, Doherty). */
export function wipeCountAnnounce(count: number): CrisisAnnounce {
  return status("studio.crisis.wipe.count", { count });
}

export interface WipeConfirmView {
  /** True once at least one cell is selected; disables `[Effacer]` otherwise (§3 empty path). */
  canConfirm: boolean;
  /** Empty-region hint when `count === 0` (don't dispatch a `no_cells` no-op). */
  emptyHint: CrisisAnnounce | null;
  /** Soft large-region warning shown before the confirm when the magnitude trips (§3). */
  largeWarning: CrisisAnnounce | null;
  /** "Effacer {count} cellules ? Ce qui était dessous réapparaît." (reaffirms §2.5). */
  confirm: CrisisAnnounce;
}

/** Build the wipe confirm surface from the live cell count + canvas bounds (spec §3.3). */
export function wipeConfirmView(count: number, bounds: CanvasBounds): WipeConfirmView {
  return {
    canConfirm: count > 0,
    emptyHint: count > 0 ? null : status("studio.crisis.wipe.empty"),
    largeWarning: wipeIsLarge(count, bounds) ? status("studio.crisis.wipe.large", { count }) : null,
    confirm: status("studio.crisis.wipe.confirm", { count }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared dispatch result (§2.6 / §3.5) — clean vs. caveat vs. error.
// ─────────────────────────────────────────────────────────────────────────────

/** The `{ dispatched, detail }` shape every `moderation` action returns. */
export interface ModerationResult {
  cellsAffected: number;
  dispatched: boolean;
  detail: string;
}

export type ModerationOutcome = "clean" | "pending" | "noop" | "error";

/**
 * Classify a `moderation` action result (spec §2.6). `dispatched` true → the
 * pixels are overwritten on the live/OBS canvas (CLEAN success). `dispatched`
 * false + `gateway_not_configured` → durable + restorable but NOT yet on the live
 * canvas (the neutral caveat — must NOT render as clean success). `no_cells` →
 * a no-op (we guard 0 cells before dispatch, so this is defensive). Anything else
 * → error. A thrown action (gateway 5xx) is caught by the host and rendered error.
 */
export function classifyResult(result: ModerationResult): ModerationOutcome {
  if (result.dispatched) return "clean";
  if (result.detail === "gateway_not_configured") return "pending";
  if (result.detail === "no_cells") return "noop";
  return "error";
}

export type CrisisFlow = "ban" | "wipe";

/**
 * The post-dispatch announcement for a ban/wipe (spec §2.6 + §5 keys). Clean
 * success names the count and is polite; the `pending` caveat is a DISTINCT
 * neutral key (`role=status`, no "réessaie"); errors are assertive with retry.
 */
export function resultAnnounce(flow: CrisisFlow, result: ModerationResult): CrisisAnnounce {
  const outcome = classifyResult(result);
  if (flow === "ban") {
    switch (outcome) {
      case "clean":
        return status("studio.crisis.ban.success", { count: result.cellsAffected });
      case "pending":
        return status("studio.crisis.ban.successPending");
      default:
        return alert("studio.crisis.ban.error");
    }
  }
  switch (outcome) {
    case "clean":
      return status("studio.crisis.wipe.success", { count: result.cellsAffected });
    case "pending":
      return status("studio.crisis.wipe.successPending");
    default:
      return alert("studio.crisis.wipe.error");
  }
}

/** Cancel/Escape announcement, shared by every flow (spec §2/§3 cancel path). */
export function cancelledAnnounce(): CrisisAnnounce {
  return status("studio.crisis.cancelled");
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore flow (§4) — "Actions récentes" undo list.
// ─────────────────────────────────────────────────────────────────────────────

/** A raw `listAuditLog` row (the subset the undo list reads). */
export interface AuditRow {
  _id: string;
  action: string;
  targetUserId?: string | null;
  cellsAffected: number;
  createdAt: number;
}

/** Reversible removals surfaced in the undo list (spec §4 filter). */
const REVERSIBLE_ACTIONS = new Set(["ban_wipe", "delete"]);

export interface UndoRowView {
  id: string;
  /** Row label: "Effacement — {count} cellules" or "Bannissement de {author} — {count} pixels" (§4). */
  label: CrisisAnnounce;
  /** Epoch ms — the React layer renders a locale relative time ("il y a 2 min"). */
  createdAt: number;
  /** True once restored (idempotent re-restore is a 0-cell no-op) — row reads "Restauré", action disabled. */
  restored: boolean;
}

/**
 * Project `listAuditLog` rows onto the undo list (spec §4): keep only reversible
 * removals (`ban_wipe`/`delete`), newest-first preserved, each labelled by kind +
 * size. `restoredIds` are rows the host has already restored this session (the
 * backend has no per-row "restored" flag; a successful/idempotent restore marks
 * the id locally → the row reads "Restauré" and its affordance disables, §4).
 * `anonLabel` is the resolved localized author fallback (the audit row carries an
 * opaque `targetUserId`, not a display name) — passed in so this stays pure.
 */
export function buildUndoList(
  rows: readonly AuditRow[],
  restoredIds: ReadonlySet<string> = new Set(),
  anonLabel = "",
): UndoRowView[] {
  return rows
    .filter((r) => REVERSIBLE_ACTIONS.has(r.action))
    .map((r) => ({
      id: r._id,
      label:
        r.action === "ban_wipe"
          ? status("studio.crisis.history.banRow", {
              author: anonLabel,
              count: r.cellsAffected,
            })
          : status("studio.crisis.history.wipeRow", { count: r.cellsAffected }),
      createdAt: r.createdAt,
      restored: restoredIds.has(r._id),
    }));
}

/**
 * Restore confirm (spec §4 forewarning): restore re-applies the removed colours
 * OVER whatever is on those cells now, so recent poses there get overwritten —
 * stated honestly, not a hard block.
 */
export function restoreConfirmView(pendingCells: number): CrisisAnnounce {
  return status("studio.crisis.restore.confirm", { count: pendingCells });
}

/** Post-restore announcement (spec §4 success). */
export function restoreResultAnnounce(result: ModerationResult): CrisisAnnounce {
  if (classifyResult(result) === "error") return alert("studio.crisis.history.error");
  return status("studio.crisis.restore.success", { count: result.cellsAffected });
}
