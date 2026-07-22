/**
 * Streamer studio view-model tests (FEN-120 / Lot H) — Definition-of-Done.
 *
 * Logic-only (no DOM/Convex), matching the web `test` script. Covers the lot's
 * acceptance criteria expressed as pure functions:
 *   - Dashboard: exactly one active canvas highlighted, archives read-only below,
 *     greenfield empty-state, signed-out gate ("quel canvas est en ligne" = the
 *     `active` slot; F11).
 *   - Création minimale: empty name is valid (backend default), advanced options
 *     omitted ⇒ pure-default args (flow S1), over-long name rejected pre-submit.
 *   - Diffuser: the OBS URL is `{origin}/{slug}/obs` (flow S2 / obs.ts route).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SIZE_KEY,
  MAX_CANVAS_NAME,
  SIZE_PRESETS,
  buildCreateArgs,
  buildDashboardView,
  buildObsUrl,
  createErrorKey,
  describeActive,
  sizePreset,
  splitCanvases,
  validateCanvasName,
  type StreamerCanvas,
} from "./studioView.ts";

function canvas(over: Partial<StreamerCanvas> = {}): StreamerCanvas {
  return {
    id: over.id ?? "c1",
    slug: over.slug ?? "my-canvas",
    title: over.title ?? "My canvas",
    status: over.status ?? "active",
    placementOpen: over.placementOpen ?? true,
    isPublic: over.isPublic ?? false,
    width: over.width ?? 100,
    height: over.height ?? 100,
    viewerCount: over.viewerCount ?? 0,
    createdAt: over.createdAt ?? 1_000,
    archivedAt: over.archivedAt ?? null,
  };
}

// ── Dashboard split (WF-5 / F11) ─────────────────────────────────────────────

test("splitCanvases highlights the single active canvas, archives the rest", () => {
  const active = canvas({ id: "a", status: "active", createdAt: 30 });
  const old1 = canvas({ id: "o1", status: "archived", createdAt: 10, archivedAt: 20 });
  const old2 = canvas({ id: "o2", status: "archived", createdAt: 5, archivedAt: 25 });
  const { active: got, archives } = splitCanvases([old1, active, old2]);
  assert.equal(got, active);
  // Archives newest-archived first (o2 archived@25 before o1 archived@20).
  assert.deepEqual(archives.map((c) => c.id), ["o2", "o1"]);
});

test("splitCanvases is defensive: multiple actives → newest wins, others demoted", () => {
  const newer = canvas({ id: "new", status: "active", createdAt: 50 });
  const older = canvas({ id: "old", status: "active", createdAt: 10 });
  const { active, archives } = splitCanvases([older, newer]);
  assert.equal(active, newer);
  assert.deepEqual(archives.map((c) => c.id), ["old"]);
});

test("describeActive maps placement + visibility to status keys", () => {
  assert.equal(describeActive(canvas({ placementOpen: true })).statusKey, "studio.status.open");
  assert.equal(describeActive(canvas({ placementOpen: false })).statusKey, "studio.status.frozen");
  assert.equal(describeActive(canvas({ isPublic: true })).visibilityKey, "studio.visibility.public");
  assert.equal(describeActive(canvas({ isPublic: false })).visibilityKey, "studio.visibility.private");
});

test("buildDashboardView gates on auth and surfaces loading", () => {
  assert.deepEqual(buildDashboardView(undefined, { isSignedIn: false }), { state: "signedOut" });
  assert.deepEqual(buildDashboardView(undefined, { isSignedIn: true }), { state: "loading" });
});

test("buildDashboardView greenfield: signed in, no canvases → empty, no active", () => {
  const view = buildDashboardView([], { isSignedIn: true });
  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.equal(view.active, null);
  assert.equal(view.isEmpty, true);
  assert.deepEqual(view.archives, []);
});

test("buildDashboardView ready: one active promoted, archives read-only below", () => {
  const view = buildDashboardView(
    [
      canvas({ id: "a", status: "active", createdAt: 100, slug: "live" }),
      canvas({ id: "b", status: "archived", createdAt: 10, archivedAt: 50 }),
    ],
    { isSignedIn: true },
  );
  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.equal(view.active?.canvas.slug, "live");
  assert.equal(view.isEmpty, false);
  assert.equal(view.archives.length, 1);
  assert.equal(view.archives[0]!.canvas.id, "b");
});

// ── Diffuser / OBS URL (WF-7 / flow S2) ──────────────────────────────────────

test("buildObsUrl targets the /{slug}/obs browser-source route", () => {
  assert.equal(buildObsUrl("https://liveplace.tv", "neon"), "https://liveplace.tv/neon/obs");
  // Trailing slash on the origin is normalised (no double slash).
  assert.equal(buildObsUrl("https://liveplace.tv/", "neon"), "https://liveplace.tv/neon/obs");
});

// ── Création minimale (WF-6 / flow S1) ───────────────────────────────────────

test("validateCanvasName accepts an empty name (backend default title)", () => {
  const v = validateCanvasName("   ");
  assert.equal(v.ok, true);
  assert.equal(v.trimmed, "");
  assert.equal(v.reasonKey, undefined);
});

test("validateCanvasName trims and rejects an over-long name pre-submit", () => {
  assert.deepEqual(validateCanvasName("  Neon City  "), { ok: true, trimmed: "Neon City" });
  const tooLong = "x".repeat(MAX_CANVAS_NAME + 1);
  const v = validateCanvasName(tooLong);
  assert.equal(v.ok, false);
  assert.equal(v.reasonKey, "studio.create.nameTooLong");
});

test("buildCreateArgs minimal path: empty name + untouched advanced ⇒ {} (pure defaults)", () => {
  assert.deepEqual(buildCreateArgs({ name: "" }), {});
});

test("buildCreateArgs carries only the fields the streamer set", () => {
  assert.deepEqual(buildCreateArgs({ name: "  Neon  " }), { title: "Neon" });
  assert.deepEqual(buildCreateArgs({ name: "Neon", sizeKey: "l" }), {
    title: "Neon",
    width: 100,
    height: 100,
  });
  assert.deepEqual(buildCreateArgs({ name: "", isPublic: true }), { isPublic: true });
  assert.deepEqual(buildCreateArgs({ name: "" }), {});
});

test("size presets: 4 options, default key xs mirrors the backend default 10", () => {
  assert.equal(SIZE_PRESETS.length, 4);
  assert.equal(DEFAULT_SIZE_KEY, "xs");
  assert.equal(sizePreset("xs").dimension, 10);
  assert.equal(sizePreset("s").dimension, 20);
  assert.equal(sizePreset("m").dimension, 50);
  assert.equal(sizePreset("l").dimension, 100);
  // Every preset stays within the canvasRules MIN/MAX dimension bounds (10…512 after 3a).
  for (const p of SIZE_PRESETS) {
    assert.ok(p.dimension >= 10 && p.dimension <= 512, `${p.key} in bounds`);
  }
});

test("createErrorKey maps server errors to stable reason keys", () => {
  assert.equal(
    createErrorKey(new Error('slug "neon" is already taken.')),
    "studio.create.errorNameTaken",
  );
  assert.equal(createErrorKey(new Error("invalid_title: …")), "studio.create.nameTooLong");
  assert.equal(createErrorKey(new Error("network down")), "studio.create.error");
  assert.equal(createErrorKey("boom"), "studio.create.error");
});
