/**
 * Tests for the public gallery read-model (F12, FEN-23).
 *   node --test apps/convex/convex/lib/gallery.test.ts
 *
 * Covers CA1 (only public+active are listable), CA2 (slug click-through key),
 * the allow-list projection (no ownerId/private leak), thumbnail pass-through
 * (G-Perf3 — never computed here), viewer-count clamping, the streamer fallback,
 * and the activity sort.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toGalleryItem,
  compareByActivity,
  isListablePublicCanvas,
  activityTimestamp,
  type GalleryCanvasRow,
  type GalleryStreamerRow,
} from "./gallery.ts";

function canvas(overrides: Partial<GalleryCanvasRow> = {}): GalleryCanvasRow {
  return {
    _id: "cv_1",
    slug: "pixelqueen",
    title: "PixelQueen's canvas",
    ownerId: "user_secret_123",
    isPublic: true,
    status: "active",
    lastActivityAt: Date.UTC(2026, 5, 1),
    createdAt: Date.UTC(2026, 0, 1),
    viewerCount: 42,
    // a private/internal column that must never surface:
    paletteId: "pal_private",
    ...overrides,
  };
}

const streamer: GalleryStreamerRow = {
  login: "pixelqueen",
  displayName: "PixelQueen",
  avatarUrl: "https://cdn.twitch/pq.png",
};

test("isListablePublicCanvas — only public AND active (CA1)", () => {
  assert.equal(isListablePublicCanvas({ isPublic: true, status: "active" }), true);
  assert.equal(isListablePublicCanvas({ isPublic: false, status: "active" }), false);
  assert.equal(isListablePublicCanvas({ isPublic: true, status: "archived" }), false);
  assert.equal(isListablePublicCanvas({ isPublic: false, status: "archived" }), false);
});

test("toGalleryItem — projects only the public allow-list (CA2 boundary)", () => {
  const item = toGalleryItem(canvas(), streamer, "https://files/thumb.webp");
  assert.deepEqual(item, {
    slug: "pixelqueen",
    title: "PixelQueen's canvas",
    streamer: {
      login: "pixelqueen",
      displayName: "PixelQueen",
      avatarUrl: "https://cdn.twitch/pq.png",
    },
    thumbnailUrl: "https://files/thumb.webp",
    viewerCount: 42,
    lastActivityAt: Date.UTC(2026, 5, 1),
  });
  // No private/internal fields leak through the projection.
  const keys = Object.keys(item);
  assert.ok(!keys.includes("ownerId"));
  assert.ok(!keys.includes("_id"));
  assert.ok(!keys.includes("paletteId"));
});

test("toGalleryItem — slug is the click-through key (CA2)", () => {
  const item = toGalleryItem(canvas({ slug: "halloween-2026" }), streamer, null);
  assert.equal(item.slug, "halloween-2026");
});

test("toGalleryItem — missing thumbnail passes through as null (G-Perf3, never computed)", () => {
  const item = toGalleryItem(canvas(), streamer, null);
  assert.equal(item.thumbnailUrl, null);
});

test("toGalleryItem — viewer count is clamped to a non-negative integer", () => {
  assert.equal(toGalleryItem(canvas({ viewerCount: undefined }), streamer, null).viewerCount, 0);
  assert.equal(toGalleryItem(canvas({ viewerCount: -5 }), streamer, null).viewerCount, 0);
  assert.equal(toGalleryItem(canvas({ viewerCount: 3.9 }), streamer, null).viewerCount, 3);
  assert.equal(toGalleryItem(canvas({ viewerCount: NaN }), streamer, null).viewerCount, 0);
});

test("toGalleryItem — falls back to the slug when the streamer profile is missing", () => {
  const item = toGalleryItem(canvas({ slug: "ghost" }), null, null);
  assert.equal(item.streamer.login, "ghost");
  assert.equal(item.streamer.displayName, "ghost");
  assert.equal(item.streamer.avatarUrl, null);
});

test("activityTimestamp — uses lastActivityAt, falling back to createdAt", () => {
  assert.equal(activityTimestamp({ lastActivityAt: 500, createdAt: 100 }), 500);
  assert.equal(activityTimestamp({ createdAt: 100 }), 100);
});

test("compareByActivity — most recent first, ties break by viewers then slug", () => {
  const a = toGalleryItem(canvas({ slug: "a", lastActivityAt: 300, viewerCount: 1 }), streamer, null);
  const b = toGalleryItem(canvas({ slug: "b", lastActivityAt: 200, viewerCount: 1 }), streamer, null);
  const c = toGalleryItem(canvas({ slug: "c", lastActivityAt: 300, viewerCount: 9 }), streamer, null);
  const d = toGalleryItem(canvas({ slug: "d", lastActivityAt: 300, viewerCount: 9 }), streamer, null);
  const sorted = [a, b, c, d].sort(compareByActivity);
  // c & d tie on activity+viewers → slug asc (c before d); both beat a (fewer
  // viewers, same activity); a beats b (more recent activity).
  assert.deepEqual(sorted.map((i) => i.slug), ["c", "d", "a", "b"]);
});
