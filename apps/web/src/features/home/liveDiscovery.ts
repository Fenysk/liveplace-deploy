/**
 * Live canvas detection helpers (G6 / FEN-611).
 * The "En live maintenant" rail was removed in FEN-1423; these utilities are
 * kept as a shared source-of-truth for the live threshold.
 */

/** Minutes without activity after which a canvas is no longer considered live. */
export const N_LIVE_MIN = 10;

/** True when the canvas has had a placement within N_LIVE_MIN of nowMs. */
export function isLiveCanvas(lastActivityAt: number, nowMs: number): boolean {
  return nowMs - lastActivityAt <= N_LIVE_MIN * 60 * 1000;
}
