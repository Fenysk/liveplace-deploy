/**
 * "Partager" link logic (FEN-304, Étape 3) — pure, DOM/React-free so the whole
 * share contract unit-tests under the logic-only node runner (see share.test.ts;
 * same convention as placeState.ts / net.ts). The React shell lives in
 * {@link ../ShareButton}.
 *
 * Two responsibilities, both pure:
 *   - {@link buildShareUrl}: turn the current `slug` into the ABSOLUTE public
 *     `/c/:slug` URL to copy (reusing `paths.canvas()` so the link can never
 *     drift from the route the router actually accepts — AC3).
 *   - {@link copyToClipboard}: a three-tier copy strategy that NEVER throws
 *     (AC8) — `navigator.clipboard.writeText` → `execCommand("copy")` →
 *     `"manual"`, with every dependency injectable so all branches are tested
 *     headlessly.
 */

/**
 * Absolute public URL for the canvas `slug` (AC3). `origin` is the live
 * `window.location.origin` at the call site; `slug` null → the home page
 * (`${origin}/`), a named canvas → `${origin}/${encodeURIComponent(slug)}`
 * (FEN-433: canonical form, no `/c/` prefix).
 *
 * This MIRRORS `routes.ts#paths.canvas()` exactly — same `/${slug}` shape, same
 * `encodeURIComponent`, same null→`/` default — so the shared link always matches
 * a real route and never 404s. It is inlined rather than imported because this
 * module is unit-tested under the logic-only node runner, which (like every
 * other tested logic module here: placeState.ts, cooldown.ts…) cannot resolve a
 * relative `.js`→`.ts` import. Keep the two in lockstep if the route changes.
 */
export function buildShareUrl(origin: string, slug: string | null): string {
  return slug ? `${origin}/${encodeURIComponent(slug)}` : `${origin}/`;
}

/** Injectable clipboard dependencies — defaults read the live browser globals. */
export interface ClipboardDeps {
  /** `navigator.clipboard` (absent in insecure contexts / old browsers). */
  clipboard?: { writeText(text: string): Promise<void> };
  /** Synchronous `execCommand("copy")` fallback; returns whether it copied. */
  execCommandCopy?: (text: string) => boolean;
}

/** Outcome of a copy attempt — `"manual"` means "show the link for hand-copy". */
export type CopyOutcome = "copied" | "manual";

/**
 * Copy `text` to the clipboard with a graceful three-tier fallback (AC8). NEVER
 * rejects: every path is guarded, so the caller can `await` without a try/catch
 * and a copy failure degrades to a visible manual-copy affordance rather than a
 * crash.
 *
 *   1. `clipboard.writeText` (nominal, secure-context async API);
 *   2. on absence/rejection → `execCommandCopy` (deprecated but still works as a
 *      last-resort sync fallback in insecure contexts);
 *   3. on absence/failure of both → `"manual"`.
 *
 * `deps` defaults to the live browser globals; tests inject stubs to exercise
 * each branch without a real DOM.
 */
export async function copyToClipboard(
  text: string,
  deps: ClipboardDeps = defaultClipboardDeps(),
): Promise<CopyOutcome> {
  // Tier 1 — the modern async Clipboard API.
  if (deps.clipboard?.writeText) {
    try {
      await deps.clipboard.writeText(text);
      return "copied";
    } catch {
      // fall through to the legacy fallback
    }
  }

  // Tier 2 — legacy execCommand, guarded against throws too.
  if (deps.execCommandCopy) {
    try {
      if (deps.execCommandCopy(text)) return "copied";
    } catch {
      // fall through to manual
    }
  }

  // Tier 3 — nothing worked; the caller surfaces the link for manual copy.
  return "manual";
}

/**
 * Live browser clipboard deps. `navigator.clipboard` is read defensively (it is
 * absent in insecure contexts); the `execCommand` fallback creates a throwaway
 * off-screen textarea, selects it, and runs the deprecated copy command — kept
 * ONLY as a repli, never the nominal path.
 */
function defaultClipboardDeps(): ClipboardDeps {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    clipboard:
      nav && "clipboard" in nav && typeof nav.clipboard?.writeText === "function"
        ? nav.clipboard
        : undefined,
    execCommandCopy: (text: string): boolean => {
      if (typeof document === "undefined") return false;
      const textarea = document.createElement("textarea");
      textarea.value = text;
      // Keep it out of the viewport / tab order while still selectable.
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        return document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    },
  };
}
