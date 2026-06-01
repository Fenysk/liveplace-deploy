/**
 * Presentation view-model for the public profile page `/u/{login}` (F11, FEN-22).
 *
 * Pure and React-free so it unit-tests without a DOM and keeps all display logic
 * (states, number formatting, i18n key selection) out of the JSX. The component
 * (`ProfilePage.tsx`) calls `buildProfileView` with the Convex query result and
 * renders the returned descriptor. i18n keys are RETURNED, not resolved here, so
 * this stays locale-agnostic — see docs/contracts/profile-read.md.
 *
 * The shape below mirrors the `getPublicProfile` query result (contract); it is
 * re-declared locally to avoid coupling the web build to the Convex package.
 */

export interface PublicUserVM {
  login: string;
  displayName: string;
  avatarUrl: string | null;
  memberSince: number;
}

export interface CanvasStatVM {
  canvasSlug: string;
  canvasTitle: string;
  pixelsPlaced: number;
  points: number;
  bestRank: number | null;
}

export interface PublicProfile {
  user: PublicUserVM;
  totals: { pixelsPlaced: number; points: number; canvasesJoined: number };
  canvases: CanvasStatVM[];
}

/** A formatted stat ready to render (already number-formatted for the locale). */
export interface CanvasRowView {
  canvasSlug: string;
  canvasTitle: string;
  pixelsPlaced: string;
  points: string;
  /** Pre-resolved rank label key + params, or null when unranked. */
  bestRank: { key: "profile.rank"; params: { rank: string } } | null;
}

export type ProfileView =
  | { state: "loading" }
  | { state: "notFound"; titleKey: "profile.notFound" }
  | {
      state: "ready";
      avatarUrl: string | null;
      displayName: string;
      login: string;
      memberSinceKey: "profile.memberSince";
      memberSinceParams: { date: string };
      totals: {
        pixelsPlaced: string;
        points: string;
        canvasesJoined: string;
      };
      /** True when the user has joined no canvas yet (show empty-state copy). */
      isEmpty: boolean;
      emptyKey: "profile.empty";
      canvases: CanvasRowView[];
    };

/**
 * Build the view descriptor from a Convex query result.
 * - `undefined`  → query still loading (Convex `useQuery` returns undefined)
 * - `null`       → no such login (404-style not-found)
 * - PublicProfile→ ready
 */
export function buildProfileView(
  result: PublicProfile | null | undefined,
  locale = "en",
): ProfileView {
  if (result === undefined) return { state: "loading" };
  if (result === null) return { state: "notFound", titleKey: "profile.notFound" };

  const nf = new Intl.NumberFormat(locale);
  const df = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
  });

  return {
    state: "ready",
    avatarUrl: result.user.avatarUrl,
    displayName: result.user.displayName,
    login: result.user.login,
    memberSinceKey: "profile.memberSince",
    memberSinceParams: { date: df.format(new Date(result.user.memberSince)) },
    totals: {
      pixelsPlaced: nf.format(result.totals.pixelsPlaced),
      points: nf.format(result.totals.points),
      canvasesJoined: nf.format(result.totals.canvasesJoined),
    },
    isEmpty: result.canvases.length === 0,
    emptyKey: "profile.empty",
    canvases: result.canvases.map((c) => ({
      canvasSlug: c.canvasSlug,
      canvasTitle: c.canvasTitle,
      pixelsPlaced: nf.format(c.pixelsPlaced),
      points: nf.format(c.points),
      bestRank:
        c.bestRank === null
          ? null
          : { key: "profile.rank", params: { rank: nf.format(c.bestRank) } },
    })),
  };
}
