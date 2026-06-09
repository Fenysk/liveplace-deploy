/**
 * View-first auth gate (FEN-115 / §V2.1, UX Lot B).
 *
 * LivePlace is "view-first": an anonymous visitor lands on `/c/{slug}`, sees the
 * live fresque, can zoom/pan and pick a colour — all WITHOUT an account. The
 * Twitch link (a quasi-instant OAuth consent, since the viewer is already logged
 * into Twitch on the stream) is deferred until the FIRST interaction that
 * actually needs an account — entering "Dessiner" mode / staging the first cell —
 * NOT only at commit. The redirect returns the viewer to the SAME canvas
 * (`callbackURL = /c/{slug}`), connected and ready to act.
 *
 * This module is the pure decision layer so the policy ("which interactions need
 * an account, and where do we come back to") is unit-testable in isolation from
 * React / the WebSocket / the renderer. {@link CanvasView} wires the decision to
 * `signInWithTwitch(callbackURL)`.
 *
 * Cancellation is non-punitive by construction: a `consent` decision only starts
 * the OAuth redirect; if the viewer backs out at Twitch they simply return to the
 * same canvas in read-only mode with nothing staged — no error state, no lockout.
 */

/** Every distinct viewer interaction the canvas can gate. */
export type CanvasInteraction =
  | "view" // watching the live fresque
  | "zoom" // wheel / pinch
  | "pan" // drag to move
  | "pick-color" // selecting a palette swatch
  | "toggle-erase" // toggling the eraser tool
  | "arm" // mobile first tap that only reveals the "Dessiner" button
  | "enter-draw" // pressing "Dessiner" — the mobile entry into draw mode
  | "stage-cell" // staging/toggling a cell into the batch
  | "validate"; // committing the staged batch

/**
 * Interactions that require a linked account. Reading the canvas, navigating it,
 * choosing a colour and arming the mobile "Dessiner" affordance stay anonymous;
 * the account is only needed to actually start composing or commit a placement.
 */
const ACCOUNT_REQUIRED: ReadonlySet<CanvasInteraction> = new Set<CanvasInteraction>([
  "enter-draw",
  "stage-cell",
  "validate",
]);

/** True when the interaction cannot proceed anonymously. */
export function requiresAccount(interaction: CanvasInteraction): boolean {
  return ACCOUNT_REQUIRED.has(interaction);
}

/**
 * Build the OAuth `callbackURL` so the viewer returns to the SAME canvas.
 *
 * FEN-433 (AC-3 / C4): canonical canvas URLs are now `/{slug}` (no `/c/`).
 * Auth from a third-party canvas → callbackURL = `/{slug}` → stays on canvas.
 * Auth from `/` → callbackURL = `/` → HomeView redirects to personal canvas.
 * Anti open-redirect: always a relative internal path, never an absolute URL.
 */
export function canvasCallbackURL(slug: string | null | undefined, currentPath = "/"): string {
  if (slug != null && slug !== "") {
    return `/${encodeURIComponent(slug)}`;
  }
  return currentPath;
}

/** The gate's verdict for one interaction. */
export type GateDecision =
  | { kind: "proceed" }
  | { kind: "consent"; callbackURL: string };

export interface GateOptions {
  /** Canvas slug; null/empty targets the default canvas. */
  slug?: string | null;
  /** Current location path, used as the callback for the default canvas. */
  currentPath?: string;
}

/**
 * Decide whether an interaction proceeds or must first trigger the Twitch
 * consent. Already-authenticated viewers and read-only interactions always
 * proceed; an account-requiring interaction by an anonymous viewer yields a
 * `consent` decision carrying the same-canvas callback URL.
 */
export function gateInteraction(
  interaction: CanvasInteraction,
  isAuthenticated: boolean,
  options: GateOptions = {},
): GateDecision {
  if (isAuthenticated || !requiresAccount(interaction)) {
    return { kind: "proceed" };
  }
  return {
    kind: "consent",
    callbackURL: canvasCallbackURL(options.slug, options.currentPath),
  };
}
