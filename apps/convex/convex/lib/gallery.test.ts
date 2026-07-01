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
  planGalleryFieldsPatch,
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

// ── Worker write path: planGalleryFieldsPatch (FEN-33) ──────────────────────

test("lastActivityAt only advances; an older/equal flush is a no-op", () => {
  const state = { lastActivityAt: 100 };
  assert.deepEqual(planGalleryFieldsPatch(state, { lastActivityAt: 150 }), {
    lastActivityAt: 150,
  });
  assert.deepEqual(planGalleryFieldsPatch(state, { lastActivityAt: 100 }), {});
  assert.deepEqual(planGalleryFieldsPatch(state, { lastActivityAt: 50 }), {});
});

test("lastActivityAt sets from undefined; non-finite is ignored", () => {
  assert.deepEqual(planGalleryFieldsPatch({}, { lastActivityAt: 10 }), {
    lastActivityAt: 10,
  });
  assert.deepEqual(planGalleryFieldsPatch({}, { lastActivityAt: NaN }), {});
});

test("viewerCount is latest-wins, clamped to a non-negative integer", () => {
  assert.deepEqual(planGalleryFieldsPatch({ viewerCount: 5 }, { viewerCount: 9 }), {
    viewerCount: 9,
  });
  // a drop is allowed (it's a level, not a counter)
  assert.deepEqual(planGalleryFieldsPatch({ viewerCount: 9 }, { viewerCount: 2 }), {
    viewerCount: 2,
  });
  // unchanged → no write
  assert.deepEqual(planGalleryFieldsPatch({ viewerCount: 3 }, { viewerCount: 3 }), {});
  // clamp + floor
  assert.deepEqual(planGalleryFieldsPatch({}, { viewerCount: -4 }), { viewerCount: 0 });
  assert.deepEqual(planGalleryFieldsPatch({}, { viewerCount: 7.8 }), { viewerCount: 7 });
});

test("thumbnail blob + version move together and only forward", () => {
  // fresh: sets both
  assert.deepEqual(
    planGalleryFieldsPatch({}, { thumbnailStorageId: "blob_1", thumbnailVersion: 3 }),
    { thumbnailStorageId: "blob_1", thumbnailVersion: 3 },
  );
  // advance: swaps blob, frees the old one
  assert.deepEqual(
    planGalleryFieldsPatch(
      { thumbnailStorageId: "blob_1", thumbnailVersion: 3 },
      { thumbnailStorageId: "blob_2", thumbnailVersion: 5 },
    ),
    { thumbnailStorageId: "blob_2", thumbnailVersion: 5, freeStorageId: "blob_1" },
  );
  // stale/equal version → no-op (idempotent redelivery), no blob churn
  assert.deepEqual(
    planGalleryFieldsPatch(
      { thumbnailStorageId: "blob_2", thumbnailVersion: 5 },
      { thumbnailStorageId: "blob_old", thumbnailVersion: 5 },
    ),
    {},
  );
  // version without a blob ref is ignored (they must be paired)
  assert.deepEqual(planGalleryFieldsPatch({}, { thumbnailVersion: 9 }), {});
});

test("an empty update yields an empty patch (no write)", () => {
  assert.deepEqual(planGalleryFieldsPatch({ lastActivityAt: 1, viewerCount: 2 }, {}), {});
});

test("independent fields merge in a single patch", () => {
  assert.deepEqual(
    planGalleryFieldsPatch(
      { lastActivityAt: 100, viewerCount: 1 },
      { lastActivityAt: 200, viewerCount: 4, thumbnailStorageId: "b", thumbnailVersion: 1 },
    ),
    { lastActivityAt: 200, viewerCount: 4, thumbnailStorageId: "b", thumbnailVersion: 1 },
  );
});
