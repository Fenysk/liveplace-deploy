/**
 * Pure decision logic for account deletion (FEN-1966, contract C-4 / §3 of the
 * FEN-1917 plan). The internal purge mutations in `account.ts` are thin
 * db-loops around these functions, so the semantics that matter — D-1 Option A
 * (NEVER delete placements outside the user's own canvases, protecting the
 * from-v0 rebuild FEN-1576), moderation-audit anonymisation, idempotent
 * re-runs — are unit-testable without a Convex runtime:
 *
 *   node --test apps/convex/convex/lib/accountPurge.test.ts
 */

/**
 * Sentinel for anonymised REQUIRED string fields (`auditLog.actorUserId`,
 * `bans.bannedBy`). Optional fields are cleared to `undefined` instead (the
 * Convex patch removes them). "" matches the gateway's system-actor stamp on
 * moderation stream records, and can never collide with a real Better Auth id.
 */
export const ANONYMIZED_ACTOR = "";

// ─────────────────────────────────────────────────────────────────────────────
// placements — D-1 Option A (§3b)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlacementRowLike {
  canvasId: string;
  userId?: string;
}

export type PlacementPurgeOp = "delete" | "anonymize" | "skip";

/**
 * What to do with one of the user's placement rows. Owned canvases are deleted
 * wholesale (§3d cascade), so their rows may go; on anyone else's canvas the
 * row is ONLY anonymised (`userId` cleared) — the collective artwork and the
 * from-v0 replay stay intact (D-1 Option A, frozen by the accepted plan).
 */
export function planPlacementPurge(
  row: PlacementRowLike,
  targetUserId: string,
  ownedCanvasIds: ReadonlySet<string>,
): PlacementPurgeOp {
  if (row.userId !== targetUserId) return "skip"; // already anonymised (re-run)
  return ownedCanvasIds.has(row.canvasId) ? "delete" : "anonymize";
}

// ─────────────────────────────────────────────────────────────────────────────
// bans (§3b)
// ─────────────────────────────────────────────────────────────────────────────

export interface BanRowLike {
  userId: string;
  bannedBy: string;
  liftedBy?: string;
}

export type BanScrub =
  | { kind: "delete" }
  | { kind: "patch"; patch: { bannedBy?: string; liftedBy?: undefined } }
  | null;

/**
 * Rows where the user is the BANNED party are deleted (they are data about the
 * user). Rows where the user acted as moderator (`bannedBy`/`liftedBy`) are
 * kept — the canvas owner's moderation audit survives — but anonymised.
 * Returns null when the row does not reference the user (incl. re-runs).
 */
export function scrubBanRow(row: BanRowLike, targetUserId: string): BanScrub {
  if (row.userId === targetUserId) return { kind: "delete" };
  const patch: { bannedBy?: string; liftedBy?: undefined } = {};
  if (row.bannedBy === targetUserId) patch.bannedBy = ANONYMIZED_ACTOR;
  if (row.liftedBy === targetUserId) patch.liftedBy = undefined;
  return Object.keys(patch).length > 0 ? { kind: "patch", patch } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// canvasModerators (§3b)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModeratorRowLike {
  userId?: string;
  twitchId: string;
}

/**
 * A moderator-roster row is deleted when it names the user — by app id OR by
 * their stable Twitch id (twitch_sync rows can exist before first sign-in,
 * carrying only the twitchId).
 */
export function moderatorRowMatches(
  row: ModeratorRowLike,
  targetUserId: string,
  targetTwitchId: string | null,
): boolean {
  if (row.userId === targetUserId) return true;
  return targetTwitchId !== null && targetTwitchId !== "" && row.twitchId === targetTwitchId;
}

// ─────────────────────────────────────────────────────────────────────────────
// pixelModeration / auditLog — anonymise, never delete (§3b)
// ─────────────────────────────────────────────────────────────────────────────

/** True when the row's `removedUserId` must be cleared to `undefined`. */
export function pixelModerationNeedsScrub(
  row: { removedUserId?: string },
  targetUserId: string,
): boolean {
  return row.removedUserId === targetUserId;
}

export interface AuditRowLike {
  actorUserId: string;
  targetUserId?: string;
}

/**
 * The moderation journal survives (the canvas owner's history is not the
 * user's data) but loses the identity: both roles are anonymised when they
 * name the user. Returns the patch to apply, or null (nothing to do / re-run).
 */
export function scrubAuditRow(
  row: AuditRowLike,
  targetUserId: string,
): { actorUserId?: string; targetUserId?: undefined } | null {
  const patch: { actorUserId?: string; targetUserId?: undefined } = {};
  if (row.actorUserId === targetUserId) patch.actorUserId = ANONYMIZED_ACTOR;
  if (row.targetUserId === targetUserId) patch.targetUserId = undefined;
  return Object.keys(patch).length > 0 ? patch : null;
}
