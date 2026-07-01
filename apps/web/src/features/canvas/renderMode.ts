/**
 * OBS-vs-normal render-mode contract (FEN-1411, parent FEN-1408) — pure,
 * browser-free. The React shell (S2) imports this and calls it once on mount.
 *
 * Resolution order (D-A), strict:
 *   D  ?obs=0|false → "normal"  (explicit opt-out, wins over every other signal)
 *   C  pathname ends /obs → "obs"  (AC7, explicit opt-in via route)
 *   B  ?obs=1|true → "obs"  (AC4, explicit QS opt-in)
 *   A  UA contains "OBS" → "obs"  (AC2, injected by OBS Browser Source)
 *   A  hasObsStudio === true → "obs"  (AC1, window.obsstudio presence)
 *      else → "normal"  (AC5)
 */

export type RenderMode = "obs" | "normal";

export interface RenderModeInput {
  pathname: string;
  search: string;
  userAgent: string;
  hasObsStudio: boolean;
}

export function resolveRenderMode(input: RenderModeInput): RenderMode {
  const params = new URLSearchParams(input.search);
  const obsParam = params.get("obs");

  // ?obs=0 / ?obs=false — explicit disable wins over all other signals (AC4)
  if (obsParam === "0" || obsParam === "false") return "normal";

  // /…/obs route — explicit OBS path (AC7)
  if (input.pathname.endsWith("/obs")) return "obs";

  // ?obs=1 / ?obs=true — explicit enable (AC4)
  if (obsParam === "1" || obsParam === "true") return "obs";

  // OBS Browser Source injects "OBS" into the UA string (AC2)
  if (/OBS/.test(input.userAgent)) return "obs";

  // window.obsstudio presence (AC1)
  if (input.hasObsStudio === true) return "obs";

  return "normal";
}
