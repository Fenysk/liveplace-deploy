/**
 * Public profile projection — the read-model behind the `/u/{login}` page (F11,
 * FEN-22). See the contract: docs/contracts/profile-read.md.
 *
 * Pure and framework-free (no Convex imports) so it can be unit-tested without a
 * Convex runtime and reused by the query layer and any future SSR path.
 *
 * It is also the **CA2 security boundary**: it receives a profile row plus the
 * caller's stat rows and returns ONLY an explicit allow-list of public fields.
 * Identity lives in the Better Auth component (private: email, OAuth tokens);
 * the app-owned `profiles` table is the public mirror this projects from. Even
 * if a private column is added to the source row later, it can never leak here,
 * because the projection is allow-list, not deny-list.
 */

/**
 * App-owned public identity mirror (`profiles` table), populated on sign-in by
 * syncing the Better Auth user. The index signature tolerates extra/private
 * columns without surfacing them.
 */
export interface ProfileRow {
  userId: string; // Better Auth user id (ownerId, §6.1)
  login: string; // lowercased Twitch login; the `/u/{login}` key
  displayName: string;
  avatarUrl?: string | null;
  createdAt: number;
  [key: string]: unknown;
}

/** One aggregate row per (user, canvas), written by the persistence worker (FEN-17). */
export interface StatRow {
  canvasId: string;
  pixelsPlaced: number;
  points: number;
  lastPlacedAt?: number;
}

/** Minimal canvas metadata needed to label a stat row (from the `canvases` table). */
export interface CanvasRow {
  _id: string;
  slug: string;
  title: string;
}

export interface PublicUser {
  login: string;
  displayName: string;
  avatarUrl: string | null;
  /** Epoch ms of account creation. Non-sensitive; used for "member since". */
  memberSince: number;
}

export interface CanvasStat {
  canvasSlug: string;
  canvasTitle: string;
  pixelsPlaced: number;
  points: number;
}

export interface PublicProfile {
  user: PublicUser;
  totals: {
    pixelsPlaced: number;
    points: number;
    canvasesJoined: number;
  };
  /** Per-canvas breakdown, best canvases (most points) first. (CA1) */
  canvases: CanvasStat[];
}

/**
 * Allow-list projection of a profile row to its public shape. (CA2)
 * Only the four fields below are ever surfaced — never email/tokens/internal ids.
 */
export function toPublicUser(p: ProfileRow): PublicUser {
  return {
    login: p.login,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl ?? null,
    memberSince: p.createdAt,
  };
}

/**
 * Build the full public profile for a user from their stat rows and a canvas
 * lookup. Rows whose canvas is unknown/deleted are skipped. Canvases are sorted
 * best-first (most points, tie-broken by pixels placed). (CA1)
 */
export function buildPublicProfile(input: {
  profile: ProfileRow;
  stats: StatRow[];
  canvasOf: (canvasId: string) => CanvasRow | null;
}): PublicProfile {
  const canvases: CanvasStat[] = [];
  let totalPixels = 0;
  let totalPoints = 0;

  for (const s of input.stats) {
    const canvas = input.canvasOf(s.canvasId);
    if (!canvas) continue; // canvas deleted or not yet flushed — skip defensively
    totalPixels += s.pixelsPlaced;
    totalPoints += s.points;
    canvases.push({
      canvasSlug: canvas.slug,
      canvasTitle: canvas.title,
      pixelsPlaced: s.pixelsPlaced,
      points: s.points,
    });
  }

  canvases.sort(
    (a, b) => b.points - a.points || b.pixelsPlaced - a.pixelsPlaced,
  );

  return {
    user: toPublicUser(input.profile),
    totals: {
      pixelsPlaced: totalPixels,
      points: totalPoints,
      canvasesJoined: canvases.length,
    },
    canvases,
  };
}
