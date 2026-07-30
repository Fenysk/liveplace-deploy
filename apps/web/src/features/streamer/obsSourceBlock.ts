/**
 * Pure OBS URL copy logic — React-free and DOM-free so it tests headlessly
 * under `node --experimental-transform-types` (same convention as share.ts,
 * crisisView.ts, studioView.ts). The React shell lives in ObsSourceBlock.tsx.
 *
 * FEN-1216 (Stream A): contract frozen here so Stream B (sheet) and Stream C
 * (route page) can both depend on the same copy behaviour.
 */

/** Injectable clipboard deps — defaults fall back to live browser globals. */
export interface ObsCopyDeps {
  clipboard?: { writeText(text: string): Promise<void> };
  /** Called when the clipboard write fails so the user can press ⌘/Ctrl+C. */
  selectInput?: () => void;
}

/** Outcome of a copy attempt. "failed" ↔ surface the manual-copy toast. */
export type ObsCopyResult = "copied" | "failed";

/**
 * Copy `url` to the clipboard with a read-only input select fallback.
 * NEVER rejects — the caller can `await` without try/catch and act on the
 * returned outcome. `deps` defaults to live browser globals; tests inject
 * stubs to exercise each branch headlessly.
 */
export async function copyObsUrl(
  url: string,
  deps: ObsCopyDeps = {},
): Promise<ObsCopyResult> {
  const clipboard =
    deps.clipboard ??
    (typeof navigator !== "undefined" && "clipboard" in navigator
      ? navigator.clipboard
      : undefined);

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(url);
      return "copied";
    } catch {
      // Clipboard blocked (insecure context / permission denied).
    }
  }

  // Clipboard unavailable or blocked — pre-select so Ctrl/⌘+C is one press.
  deps.selectInput?.();
  return "failed";
}
