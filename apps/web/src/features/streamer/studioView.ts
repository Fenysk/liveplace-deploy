/**
 * Streamer studio — pure view-model + helpers (FEN-120 / Lot H).
 *
 * React- and Convex-free, so the dashboard active/archives split, the OBS URL
 * builder, the size-preset "consequence" copy and the create-form validation all
 * unit-test headlessly (the web `test` script is logic-only — see routes.test.ts
 * / galleryView.test.ts). The streamer screens (DashboardPage / CreateCanvasPage
 * / BroadcastPage) are thin: they subscribe to the Convex canvas-lifecycle
 * functions (`canvases.*`, `palettes.*`), hand the result here, and render the
 * returned descriptor. i18n keys are RETURNED, never resolved here, so this stays
 * locale-agnostic (same convention as galleryView.ts).
 *
 * Spec: FEN-83 ux-spec §D6 flows S1/S2, §D7 WF-5/6/7, persona Sam (F9/F10/F11).
 * Backend contract: apps/convex/convex/canvases.ts + palettes.ts (all exists).
 */

/** A canvas row as returned by `canvases:listMyCanvases` (subset we render). */
export interface StreamerCanvas {
  id: string;
  slug: string;
  title: string;
  status: "active" | "archived";
  placementOpen: boolean;
  isPublic: boolean;
  width: number;
  height: number;
  viewerCount: number;
  createdAt: number;
  archivedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (WF-5): one active canvas highlighted + read-only archives below.
// ─────────────────────────────────────────────────────────────────────────────

/** Liveness of the highlighted active canvas — drives its status line copy. */
export type ActiveStatusKey =
  | "studio.status.open"
  | "studio.status.frozen";

/** Visibility badge copy for the active canvas. */
export type VisibilityKey =
  | "studio.visibility.public"
  | "studio.visibility.private";

/** The single active canvas, decorated with its status/visibility i18n keys. */
export interface ActiveCanvasView {
  canvas: StreamerCanvas;
  /** "Open" vs "Frozen" (placement paused) — answers "is it live right now". */
  statusKey: ActiveStatusKey;
  visibilityKey: VisibilityKey;
}

/** One archive row (read-only); `archivedAt` is forwarded for date formatting. */
export interface ArchiveRowView {
  canvas: StreamerCanvas;
}

export type DashboardView =
  | { state: "loading" }
  | { state: "signedOut" }
  | {
      state: "ready";
      /** Null when the streamer has no active canvas (show the empty CTA). */
      active: ActiveCanvasView | null;
      archives: ArchiveRowView[];
      /** True when there are no canvases at all (greenfield: prompt to create). */
      isEmpty: boolean;
    };

/**
 * Partition the caller's canvases into the single active one + the archives,
 * newest-archived first. Defensive against the one-active invariant ever being
 * violated (more than one active row): the most-recently-created active wins and
 * the stragglers are surfaced as archives so nothing silently disappears.
 */
export function splitCanvases(canvases: readonly StreamerCanvas[]): {
  active: StreamerCanvas | null;
  archives: StreamerCanvas[];
} {
  const actives = canvases
    .filter((c) => c.status === "active")
    .sort((a, b) => b.createdAt - a.createdAt);
  const active = actives[0] ?? null;
  const archives = canvases
    .filter((c) => c !== active)
    .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));
  return { active, archives };
}

/** Decorate the active canvas with the status/visibility keys the card renders. */
export function describeActive(canvas: StreamerCanvas): ActiveCanvasView {
  return {
    canvas,
    statusKey: canvas.placementOpen ? "studio.status.open" : "studio.status.frozen",
    visibilityKey: canvas.isPublic ? "studio.visibility.public" : "studio.visibility.private",
  };
}

/** Build the dashboard descriptor (WF-5) from the raw query result. */
export function buildDashboardView(
  canvases: readonly StreamerCanvas[] | undefined,
  opts: { isSignedIn: boolean },
): DashboardView {
  if (!opts.isSignedIn) return { state: "signedOut" };
  if (canvases === undefined) return { state: "loading" };
  const { active, archives } = splitCanvases(canvases);
  return {
    state: "ready",
    active: active ? describeActive(active) : null,
    archives: archives.map((canvas) => ({ canvas })),
    isEmpty: canvases.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diffuser / OBS (WF-7, flow S2): the read-only browser-source URL + checklist.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The OBS browser-source URL for a canvas. The OBS overlay is served at
 * `/{slug}/obs` (apps/web/src/features/canvas/obs.ts#isObsPath), so the absolute
 * URL a streamer pastes into OBS is `{origin}/{slug}/obs`. Slugs are validated
 * server-side to the url-safe `[a-z0-9-]` grammar (canvasRules.SLUG_RE), so no
 * extra escaping is needed; we only normalise a trailing slash on the origin.
 */
export function buildObsUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/${slug}/obs`;
}

/** The three numbered OBS setup steps + the self-check, as ordered i18n keys. */
export const BROADCAST_STEP_KEYS = [
  "studio.broadcast.step1",
  "studio.broadcast.step2",
  "studio.broadcast.step3",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Création (WF-6, flow S1): minimal path (name → create) + advanced, repliée.
// ─────────────────────────────────────────────────────────────────────────────

export type SizeKey = "small" | "medium" | "large";

export interface SizePreset {
  key: SizeKey;
  /** Square canvas edge in cells (within canvasRules MIN/MAX = 16…512). */
  dimension: number;
  labelKey: `studio.size.${SizeKey}`;
  /** F9 "conséquence expliquée" — what picking this size means, inline. */
  hintKey: `studio.size.${SizeKey}.hint`;
}

/**
 * Size presets with their consequence copy (F9). `medium` (100×100) mirrors the
 * backend default (`canvasRules.DEFAULT_DIMENSION`) so the minimal path — create
 * without touching advanced options — and an explicit "medium" pick agree.
 */
export const SIZE_PRESETS: readonly SizePreset[] = [
  { key: "small", dimension: 50, labelKey: "studio.size.small", hintKey: "studio.size.small.hint" },
  { key: "medium", dimension: 100, labelKey: "studio.size.medium", hintKey: "studio.size.medium.hint" },
  { key: "large", dimension: 250, labelKey: "studio.size.large", hintKey: "studio.size.large.hint" },
];

/** The default size key (matches the backend default dimension). */
export const DEFAULT_SIZE_KEY: SizeKey = "medium";

/** Resolve a size key to its preset (falls back to the default). */
export function sizePreset(key: SizeKey): SizePreset {
  return SIZE_PRESETS.find((p) => p.key === key) ?? SIZE_PRESETS[1]!;
}

/** Upper bound on a canvas name (mirrors canvasRules.assertValidTitle: 1–80). */
export const MAX_CANVAS_NAME = 80;

export interface NameValidation {
  ok: boolean;
  /** Trimmed value; empty string means "use the backend default title". */
  trimmed: string;
  /** Set when invalid — the i18n key explaining why (only: too long). */
  reasonKey?: "studio.create.nameTooLong";
}

/**
 * Validate a canvas name for the minimal create path. An EMPTY name is valid —
 * the backend derives a default title (`{login}'s canvas`), so "name → Créer"
 * works with the field left blank (WF-6). Only an over-long name is rejected,
 * surfaced before submit (prevent-not-punish, C2).
 */
export function validateCanvasName(raw: string): NameValidation {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_CANVAS_NAME) {
    return { ok: false, trimmed, reasonKey: "studio.create.nameTooLong" };
  }
  return { ok: true, trimmed };
}

/** Arguments accepted by `canvases:createCanvas` (only the fields we set). */
export interface CreateCanvasArgs {
  title?: string;
  width?: number;
  height?: number;
  paletteId?: string;
  isPublic?: boolean;
}

/**
 * Build the `createCanvas` argument object from the form state, OMITTING every
 * field the streamer didn't set so the backend defaults apply. This is what
 * makes the minimal path minimal: with only a (possibly empty) name and advanced
 * options untouched, the args are `{}`/`{title}` and the server fills in 100×100,
 * default palette, placement-open, private (flow S1 "défauts pré-remplis").
 */
export function buildCreateArgs(input: {
  name: string;
  /** Provided only when the advanced size control was touched. */
  sizeKey?: SizeKey;
  /** Provided only when a non-default palette was chosen. */
  paletteId?: string | null;
  /** Provided only when the public toggle was touched. */
  isPublic?: boolean;
}): CreateCanvasArgs {
  const args: CreateCanvasArgs = {};
  const name = input.name.trim();
  if (name.length > 0) args.title = name;
  if (input.sizeKey !== undefined) {
    const { dimension } = sizePreset(input.sizeKey);
    args.width = dimension;
    args.height = dimension;
  }
  if (input.paletteId) args.paletteId = input.paletteId;
  if (input.isPublic !== undefined) args.isPublic = input.isPublic;
  return args;
}

/**
 * Map a thrown server/network error to a stable, translatable reason key for the
 * create form. The Convex mutation rejects with `Error(message)`; we sniff the
 * machine-prefixed cases (slug taken, invalid title) and otherwise fall back to a
 * generic key, so the UI never shows a raw stack to a streamer.
 */
export function createErrorKey(
  error: unknown,
): "studio.create.errorNameTaken" | "studio.create.nameTooLong" | "studio.create.error" {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/already taken/i.test(message)) return "studio.create.errorNameTaken";
  if (/invalid_title|1.?80 characters/i.test(message)) return "studio.create.nameTooLong";
  return "studio.create.error";
}
