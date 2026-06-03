/**
 * Typed seam over the durable Convex API (`apps/convex/convex/worker.ts`,
 * FEN-47). Operations are **slug-addressed** — args take the canvas `slug`, never
 * a string `canvasId` — because the backend resolves the F2 `id("canvases")`
 * itself via `canvases.by_slug` (ADR-0001).
 *
 * Trust seam (FEN-86): the underlying `worker:*` / `canvases:setGalleryFields`
 * functions are `internal*` (NOT publicly callable). Every call here goes through
 * the single public `worker:run` action, passing the shared `internalSecret`
 * (`GATEWAY_INTERNAL_SECRET`); the action authenticates then dispatches to the
 * internal function. This stays on the same `ConvexHttpClient` + URL, so it needs
 * no admin/deploy key and no cross-app `_generated` codegen.
 */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { PlacementStreamRecord } from "@canvas/redis-scripts";

/** A placement row as carried to/from Convex (userId optional == anonymous). */
export interface PlacementRecord {
  x: number;
  y: number;
  color: number;
  version: number;
  userId?: string;
  ts: number;
}

export interface CanvasDurable {
  canvasId: string;
  slug: string;
  width: number;
  height: number;
  status: "active" | "archived";
  lastSnapshotAt: number | null;
}

export interface LatestSnapshot {
  version: number;
  bytes: number;
  url: string | null;
  createdAt: number;
}

export interface FlushStateRow {
  lastStreamId: string;
  lastFlushedVersion: number;
  updatedAt: number;
}

export interface ApplyFlushResult {
  canvasFound: boolean;
  maxVersion: number;
  inserted: number;
}

/**
 * The single public dispatch action (FEN-86). `fn` selects the internal worker
 * function; `args` is its arg object (validated server-side by that function).
 * `secret` must match the Convex deployment's `GATEWAY_INTERNAL_SECRET`.
 */
const runAction = makeFunctionReference<
  "action",
  { secret: string; fn: string; args: unknown },
  unknown
>("worker:run");

/** Convert a parsed Redis stream record into the Convex placement shape. */
export function toPlacementRecord(r: PlacementStreamRecord): PlacementRecord {
  return {
    x: r.x,
    y: r.y,
    color: r.color,
    version: r.version,
    // place.lua stamps "" for anonymous (defensive only); the durable log stores
    // it as absent so `by_user` indexing matches the authenticated-placer model.
    userId: r.userId === "" ? undefined : r.userId,
    ts: r.ts,
  };
}

export class ConvexDurable {
  private readonly client: ConvexHttpClient;
  private readonly secret: string;

  constructor(url: string, secret: string) {
    // Self-hosted backend URL won't match *.convex.cloud — skip the check.
    this.client = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
    this.secret = secret;
  }

  /**
   * Invoke an internal worker function through the secret-guarded `worker:run`
   * action (FEN-86). The result type is asserted by the caller; the server-side
   * function still validates `args` strictly.
   */
  private call<T>(fn: string, args: unknown): Promise<T> {
    return this.client.action(runAction, { secret: this.secret, fn, args }) as Promise<T>;
  }

  getCanvasDurable(slug: string): Promise<CanvasDurable | null> {
    return this.call("getCanvasDurable", { slug });
  }

  getFlushState(slug: string): Promise<FlushStateRow | null> {
    return this.call("getFlushState", { slug });
  }

  getLatestSnapshot(slug: string): Promise<LatestSnapshot | null> {
    return this.call("getLatestSnapshot", { slug });
  }

  getPlacementsSince(
    slug: string,
    afterVersion: number,
    limit: number,
  ): Promise<Array<PlacementRecord & { canvasId: string }>> {
    return this.call("getPlacementsSince", { slug, afterVersion, limit });
  }

  applyFlush(
    slug: string,
    lastStreamId: string,
    placements: PlacementRecord[],
    now: number,
  ): Promise<ApplyFlushResult> {
    return this.call("applyFlush", { slug, lastStreamId, placements, now });
  }

  /** Upload a snapshot blob to Convex file storage and record it durably. */
  async recordSnapshot(
    slug: string,
    version: number,
    bytes: Uint8Array,
    now: number,
  ): Promise<{ canvasFound: boolean }> {
    const uploadUrl = await this.call<string>("generateUploadUrl", {});
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`snapshot upload failed: ${res.status} ${res.statusText}`);
    }
    const { storageId } = (await res.json()) as { storageId: string };
    return this.call("recordSnapshot", {
      slug,
      version,
      storageId,
      bytes: bytes.byteLength,
      now,
    });
  }

  /**
   * Patch the F12 gallery discovery fields onto the F2 row (FEN-33). Off the hot
   * path; the server-side merge is idempotent + monotonic and a miss (no row for
   * `slug`) is a no-op, so callers can fire-and-forget safely.
   */
  setGalleryFields(
    slug: string,
    fields: {
      lastActivityAt?: number;
      viewerCount?: number;
      thumbnailStorageId?: string;
      thumbnailVersion?: number;
    },
  ): Promise<{ updated: boolean }> {
    return this.call("setGalleryFields", { slug, ...fields });
  }

  /**
   * Upload a derived gallery thumbnail blob and point the F2 row at it (FEN-33,
   * ADR-0001: the preview pointer lives ON the row — no separate `thumbnails`
   * table). `version` is the canvas version the preview depicts; `setGalleryFields`
   * only advances it (and frees the superseded blob), so a retried thumbnail job
   * is idempotent. Reuses `worker:generateUploadUrl` (same file storage).
   */
  async recordGalleryThumbnail(
    slug: string,
    version: number,
    image: { buffer: Uint8Array; format: string; width: number; height: number },
  ): Promise<{ updated: boolean }> {
    const uploadUrl = await this.call<string>("generateUploadUrl", {});
    const contentType = image.format === "webp" ? "image/webp" : "image/png";
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: image.buffer,
    });
    if (!res.ok) {
      throw new Error(`thumbnail upload failed: ${res.status} ${res.statusText}`);
    }
    const { storageId } = (await res.json()) as { storageId: string };
    return this.setGalleryFields(slug, {
      thumbnailStorageId: storageId,
      thumbnailVersion: version,
    });
  }
}
