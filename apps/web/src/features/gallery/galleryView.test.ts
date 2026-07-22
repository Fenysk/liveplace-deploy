/**
 * Tests for the gallery page view-model (F12, FEN-23).
 *   node --test apps/web/src/features/gallery/galleryView.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGalleryView, type GalleryPage } from "./galleryView.ts";

const sample: GalleryPage = {
  page: [
    {
      slug: "halloween-2026",
      title: "Halloween 2026",
      streamer: { login: "pixelqueen", displayName: "PixelQueen", avatarUrl: "https://cdn/pq.png" },
      thumbnailUrl: "https://files/thumb.webp",
      latestSnapshotUrl: null,
      viewerCount: 1234,
      lastActivityAt: Date.UTC(2026, 5, 1),
    },
    {
      slug: "ghost",
      title: "Ghost canvas",
      streamer: { login: "ghost", displayName: "ghost", avatarUrl: null },
      thumbnailUrl: null, // not yet rendered by the worker
      latestSnapshotUrl: "https://files/snap.bin",
      viewerCount: 0,
      lastActivityAt: Date.UTC(2026, 4, 1),
    },
  ],
  isDone: false,
  continueCursor: "cursor_abc",
};

test("buildGalleryView — undefined → loading", () => {
  assert.deepEqual(buildGalleryView(undefined), { state: "loading" });
});

test("buildGalleryView — empty page is ready+empty", () => {
  const v = buildGalleryView({ page: [], isDone: true, continueCursor: null });
  assert.equal(v.state, "ready");
  if (v.state !== "ready") return;
  assert.equal(v.isEmpty, true);
  assert.equal(v.emptyKey, "gallery.empty");
  assert.deepEqual(v.cards, []);
});

test("buildGalleryView — maps cards, formats viewers, forwards pagination", () => {
  const v = buildGalleryView(sample, "en");
  assert.equal(v.state, "ready");
  if (v.state !== "ready") return;
  assert.equal(v.isEmpty, false);
  assert.equal(v.isDone, false);
  assert.equal(v.continueCursor, "cursor_abc");
  assert.equal(v.cards.length, 2);

  const [first, second] = v.cards;
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.slug, "halloween-2026"); // CA2 click-through key
  assert.equal(first.title, "Halloween 2026");
  assert.equal(first.streamerDisplayName, "PixelQueen");
  assert.equal(first.viewers, "1,234"); // locale-formatted
  assert.equal(first.twitchLive, false); // no twitchLive field → defaults false
  assert.equal(first.hasThumbnail, true);
  assert.equal(first.thumbnailUrl, "https://files/thumb.webp");

  // Missing thumbnail → placeholder flag, never a computed image (G-Perf3).
  assert.equal(second.hasThumbnail, false);
  assert.equal(second.thumbnailUrl, null);
  assert.equal(second.avatarUrl, null);
});
