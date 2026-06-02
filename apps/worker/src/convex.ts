/**
 * Typed seam over the durable Convex API (`apps/convex/convex/worker.ts`,
 * FEN-47). Every function is PUBLIC (no `ctx.auth`) and **slug-addressed** — its
 * args take the canvas `slug`, never a string `canvasId` — because the
 * self-hosted backend is reachable only by trusted services and resolves the F2
 * `id("canvases")` itself via `canvases.by_slug` (ADR-0001).
 *
 * Functions are referenced by name through `makeFunctionReference`, so the worker
 * needs no cross-app `_generated` codegen.
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

const fns = {
  applyFlush: makeFunctionReference<
    "mutation",
    { slug: string; lastStreamId: string; placements: PlacementRecord[]; now: number },
    ApplyFlushResult
  >("worker:applyFlush"),
  recordSnapshot: makeFunctionReference<
    "mutation",
    { slug: string; version: number; storageId: string; bytes: number; now: number },
    { canvasFound: boolean }
  >("worker:recordSnapshot"),
  generateUploadUrl: makeFunctionReference<"mutation", Record<string, never>, string>(
    "worker:generateUploadUrl",
  ),
  getCanvasDurable: makeFunctionReference<"query", { slug: string }, CanvasDurable | null>(
    "worker:getCanvasDurable",
  ),
  getLatestSnapshot: makeFunctionReference<"query", { slug: string }, LatestSnapshot | null>(
    "worker:getLatestSnapshot",
  ),
  getPlacementsSince: makeFunctionReference<
    "query",
    { slug: string; afterVersion: number; limit: number },
    Array<PlacementRecord & { canvasId: string }>
  >("worker:getPlacementsSince"),
  getFlushState: makeFunctionReference<"query", { slug: string }, FlushStateRow | null>(
    "worker:getFlushState",
  ),
} as const;

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

  constructor(url: string) {
    // Self-hosted backend URL won't match *.convex.cloud — skip the check.
    this.client = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
  }

  getCanvasDurable(slug: string): Promise<CanvasDurable | null> {
    return this.client.query(fns.getCanvasDurable, { slug });
  }

  getFlushState(slug: string): Promise<FlushStateRow | null> {
    return this.client.query(fns.getFlushState, { slug });
  }

  getLatestSnapshot(slug: string): Promise<LatestSnapshot | null> {
    return this.client.query(fns.getLatestSnapshot, { slug });
  }

  getPlacementsSince(
    slug: string,
    afterVersion: number,
    limit: number,
  ): Promise<Array<PlacementRecord & { canvasId: string }>> {
    return this.client.query(fns.getPlacementsSince, { slug, afterVersion, limit });
  }

  applyFlush(
    slug: string,
    lastStreamId: string,
    placements: PlacementRecord[],
    now: number,
  ): Promise<ApplyFlushResult> {
    return this.client.mutation(fns.applyFlush, { slug, lastStreamId, placements, now });
  }

  /** Upload a snapshot blob to Convex file storage and record it durably. */
  async recordSnapshot(
    slug: string,
    version: number,
    bytes: Uint8Array,
    now: number,
  ): Promise<{ canvasFound: boolean }> {
    const uploadUrl = await this.client.mutation(fns.generateUploadUrl, {});
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`snapshot upload failed: ${res.status} ${res.statusText}`);
    }
    const { storageId } = (await res.json()) as { storageId: string };
    return this.client.mutation(fns.recordSnapshot, {
      slug,
      version,
      storageId,
      bytes: bytes.byteLength,
      now,
    });
  }
}
