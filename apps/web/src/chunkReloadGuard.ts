/**
 * Stale-chunk auto-recovery (FEN-2154).
 *
 * Every build rotates the hashed chunk filenames (Vite + autoCodeSplitting). A
 * tab that kept a pre-deploy `index.html` — long-lived tab, bfcache, HTTP cache —
 * still references the OLD hashes: its next lazy `import()` 404s, the rejection
 * bubbles to the error boundary and the viewer lands on the red "Oups, un pixel
 * a sauté" screen even though a plain refresh fixes everything.
 *
 * Vite surfaces exactly this failure as a `vite:preloadError` window event
 * (fired by its preload helper when a dynamic-import chunk or its CSS fails to
 * load). We listen for it and transparently reload ONCE to pick up the fresh
 * `index.html`. A sessionStorage timestamp guards against a reload loop: if a
 * reload already happened within the window, the chunk failure is NOT a stale
 * deploy (server down, real 404…) and we let the error boundary show instead.
 *
 * The error-boundary side (`isChunkLoadError` + `attemptChunkReload`) is a
 * belt-and-braces fallback for chunk failures that reach React before/without
 * the Vite event, so ONLY module-load errors ever trigger a reload — a real
 * application crash still shows the error boundary on first render.
 */

const STORAGE_KEY = "lp:chunk-reload-at";
/** One-shot soft recovery (boundary reset + router.invalidate) — FEN-2165. */
const SOFT_RETRY_KEY = "lp:boundary-soft-retry-at";
/** Ring buffer of the last boundary errors, survives the recovery reload. */
const LAST_ERROR_KEY = "lp:last-boundary-error";
const LAST_ERROR_MAX = 5;
/** A second chunk failure within this window means reload did not help — stop. */
const RELOAD_LOOP_WINDOW_MS = 30_000;

/** Narrow module-load failures; anything else must keep hitting the boundary. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  // Chrome / Firefox / Safari messages for a failed dynamic import, plus the
  // Vite preload-helper wrapper for failed CSS deps of a lazy chunk.
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    error.message,
  );
}

interface ReloadDeps {
  now: () => number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  reload: () => void;
}

/**
 * Consume a one-shot recovery slot for `key`: allowed once per anti-loop
 * window, stamped on success. Storage access is try/caught: private-mode
 * failures degrade to "allowed" so recovery still happens.
 */
function consumeOneShot(key: string, deps?: Partial<ReloadDeps>): boolean {
  const now = deps?.now ?? Date.now;
  const getItem =
    deps?.getItem ?? ((k: string) => window.sessionStorage.getItem(k));
  const setItem =
    deps?.setItem ??
    ((k: string, value: string) => window.sessionStorage.setItem(k, value));

  let lastAt = 0;
  try {
    lastAt = Number(getItem(key) ?? "0") || 0;
  } catch {
    // Storage unreadable (private mode) — treat as never attempted.
  }
  if (now() - lastAt < RELOAD_LOOP_WINDOW_MS) return false;
  try {
    setItem(key, String(now()));
  } catch {
    // Storage unwritable — still recover; worst case the boundary shows next time.
  }
  return true;
}

/**
 * Reload once to recover a fresh index.html. Returns true when the reload was
 * triggered, false when the anti-loop guard vetoed it (caller shows the error).
 */
export function attemptChunkReload(deps?: Partial<ReloadDeps>): boolean {
  const reload = deps?.reload ?? (() => window.location.reload());
  if (!consumeOneShot(STORAGE_KEY, deps)) return false;
  reload();
  return true;
}

/**
 * One-shot in-place recovery for NON-chunk boundary errors (FEN-2165): a
 * transient render throw (e.g. a Convex query re-throwing right after a
 * long-idle tab reconnects) gets one silent boundary reset before we escalate
 * to a reload. Returns true when the caller may retry, false when a retry
 * already happened inside the window (escalate).
 */
export function attemptSoftRetry(deps?: Partial<ReloadDeps>): boolean {
  return consumeOneShot(SOFT_RETRY_KEY, deps);
}

/**
 * Persist the REAL error a boundary caught (FEN-2165) so the next recurrence
 * is diagnosable from the field instead of guessed at: sessionStorage ring of
 * the last few `{at, source, name, message, stack}` entries under
 * `lp:last-boundary-error`. sessionStorage survives the recovery reload, so
 * the breadcrumb outlives the auto-recovery that hides the error from the UI.
 */
export function recordBoundaryError(
  source: "app-boundary" | "route-boundary",
  error: unknown,
  deps?: Partial<Pick<ReloadDeps, "getItem" | "setItem">>,
): void {
  const getItem =
    deps?.getItem ?? ((k: string) => window.sessionStorage.getItem(k));
  const setItem =
    deps?.setItem ??
    ((k: string, value: string) => window.sessionStorage.setItem(k, value));
  try {
    const err = error instanceof Error ? error : undefined;
    const entry = {
      at: new Date().toISOString(),
      source,
      name: err?.name ?? typeof error,
      message: err ? err.message : String(error),
      stack: err?.stack?.slice(0, 4000) ?? null,
    };
    const prev: unknown = JSON.parse(getItem(LAST_ERROR_KEY) ?? "[]");
    const ring = (Array.isArray(prev) ? prev : []).slice(1 - LAST_ERROR_MAX);
    ring.push(entry);
    setItem(LAST_ERROR_KEY, JSON.stringify(ring));
  } catch {
    // Storage unavailable — the console.error at the call site remains the trace.
  }
}

/** Install once at boot, before the router mounts (main.tsx). */
export function installChunkReloadGuard(): void {
  window.addEventListener("vite:preloadError", (event) => {
    // preventDefault stops Vite from re-throwing into the import() caller, so
    // the reload happens without the error boundary flashing first.
    if (attemptChunkReload()) event.preventDefault();
  });
}
