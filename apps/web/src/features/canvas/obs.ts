/**
 * OBS browser-source view config (FEN-20 / F9).
 *
 * The OBS view lives at `/{slug}/obs` (or bare `/obs`) and is driven entirely by
 * the URL: a path segment selecting the canvas and query params for framing. It
 * is read-only (no placement) with a transparent background by default, so a
 * streamer can drop it in as a browser source and overlay it on their scene.
 *
 * Parsing is kept pure (string in, config out) so it is unit-testable without a
 * browser, and accepts both English and French param names (grid/grille,
 * bg/fond, zoom, crop/cadrage) since the product is bilingual (FR/EN).
 */

export interface ObsCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ObsView {
  /** Canvas slug from `/{slug}/obs`, or null for the bare `/obs` default canvas. */
  slug: string | null;
  /**
   * Background colour as a CSS hex string, or null for a transparent source
   * (the OBS default — CA1). `bg=000000`, `fond=0a0a0a`, or `bg=transparent`.
   */
  background: string | null;
  /** Draw a 1px grid between cells once zoomed in enough (`grid=1` / `grille=1`). */
  grid: boolean;
  /** Fixed device-independent px per cell (`zoom=8`); null fits the board. */
  zoom: number | null;
  /** Frame a sub-region `crop=x,y,w,h` (`cadrage=…`); null fits the board. */
  crop: ObsCrop | null;
}

/** True when the path is an OBS browser-source route (`/obs` or `/{slug}/obs`). */
export function isObsPath(pathname: string): boolean {
  return obsSlug(pathname) !== undefined;
}

/**
 * Extract the canvas slug from an OBS path.
 *   /obs            -> null   (default canvas, bare route)
 *   /main/obs       -> "main"
 *   /a/b/obs        -> "a/b"  (nested slug, kept verbatim)
 * Returns undefined when the path is not an OBS route at all.
 */
function obsSlug(pathname: string): string | null | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0 || parts[parts.length - 1] !== "obs") return undefined;
  const slug = parts.slice(0, -1).join("/");
  return slug.length > 0 ? slug : null;
}

const truthy = new Set(["1", "true", "yes", "on"]);

/** Normalise a colour param into a CSS value, or null for transparent/absent. */
function parseBackground(raw: string | null): string | null {
  if (raw === null) return null; // absent -> transparent (CA1)
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "transparent" || v === "none") return null;
  // bare hex (with or without leading #); otherwise pass through (named colours)
  if (/^#?[0-9a-f]{3,8}$/.test(v)) return v.startsWith("#") ? v : `#${v}`;
  return v;
}

/** Parse a non-negative finite number, or null. */
function parseNum(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse `x,y,w,h` (w,h must be positive); null on any malformed field. */
function parseCrop(raw: string | null): ObsCrop | null {
  if (raw === null) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return null;
  return { x, y, w, h };
}

/** Build the OBS view config from a pathname + query string. */
export function parseObsView(pathname: string, search: string): ObsView {
  const slug = obsSlug(pathname) ?? null;
  const q = new URLSearchParams(search);
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = q.get(k);
      if (v !== null) return v;
    }
    return null;
  };
  return {
    slug,
    background: parseBackground(get("bg", "fond")),
    grid: truthy.has((get("grid", "grille") ?? "").trim().toLowerCase()),
    zoom: parseNum(get("zoom")),
    crop: parseCrop(get("crop", "cadrage")),
  };
}
