/**
 * Late OBS-studio detection probe (S3 / FEN-1417, parent FEN-1408).
 *
 * OBS Browser Source normally injects `window.obsstudio` synchronously, so
 * `resolveRenderMode` in S1 catches it before first paint. Exotic embedders
 * (Chromium-based hosts that implement the OBS plugin model but set a custom
 * UA and no `?obs` param) may inject it a few frames after the JS context
 * boots. This hook covers that residual window.
 *
 * Contract:
 *   - Returns `false` on mount; flips to `true` at most once if the object
 *     appears within DEADLINE_MS — never reverts (AC10: no re-flash).
 *   - The probe runs at most ~30 rAF ticks (~500 ms at 60 fps) and then stops
 *     silently, so there is no ongoing CPU cost for normal viewers (R-Perf).
 *   - The caller (CanvasRoute in router.tsx) renders CanvasView immediately
 *     and switches to ObsView only if the late signal appears — no wait screen.
 */
import { useEffect, useState } from "react";

/** Probe window at most this long after mount (ms). */
const DEADLINE_MS = 500;

/**
 * Returns `true` once `window.obsstudio` is detected within 500 ms of mount;
 * `false` until then and permanently after the deadline without a signal.
 */
export function useObsLateDetect(): boolean {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    // Fast path: already present (edge case — S1 should have caught it, but
    // a very early injection that beat resolveRenderMode may still land here).
    if (typeof window.obsstudio !== "undefined") {
      setDetected(true);
      return;
    }

    const deadline = performance.now() + DEADLINE_MS;
    let rafId: number;

    function probe(): void {
      if (typeof window.obsstudio !== "undefined") {
        setDetected(true);
        return; // found — cancel implicit; no further rAF
      }
      if (performance.now() < deadline) {
        rafId = requestAnimationFrame(probe);
      }
      // deadline reached → stop silently, remain false
    }

    rafId = requestAnimationFrame(probe);
    return () => cancelAnimationFrame(rafId);
  }, []); // run once at mount

  return detected;
}
