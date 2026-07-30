/**
 * Redis pub/sub management for the gateway (G1 — FEN-1947).
 *
 * Handles per-canvas delta channel subscriptions, moderation event fan-out,
 * delta flush, presence refresh, and the WS heartbeat ping/pong sweep.
 */
import { encodeDelta, type ServerMessage } from "@canvas/protocol";
import { canvasDeltaChannel } from "@canvas/redis-scripts";
import { MODERATION_EVENT_CHANNEL } from "./schema";
import { parseDeltaMessage, parseModerationEvent } from "./schema";
import { parseCanvasDeltaChannel } from "./canvasId";
import type { GatewayConfig } from "./config";
import { DeltaCoalescer } from "./coalescer";
import { SeqRingBuffer } from "./ringBuffer";
import {
  readGlobalViewerCount,
  writePresence,
  type RedisPair,
} from "./redis";
import { CanvasDimsCache, type CanvasDims } from "./canvasDims";
import type { Connection } from "./connection";

export type CanvasState = {
  coalescer: DeltaCoalescer;
  ring: SeqRingBuffer;
  dims: CanvasDims;
};

export class PubSubManager {
  /** Last viewer count broadcast to clients; -1 = never broadcast. */
  lastViewerCount = -1;

  constructor(
    private readonly redis: RedisPair,
    private readonly cfg: GatewayConfig,
    private readonly clients: Set<Connection>,
    private readonly canvasStates: Map<string, CanvasState>,
    private readonly dimsCache: CanvasDimsCache,
  ) {}

  async subscribeDeltas(): Promise<void> {
    const { sub } = this.redis;
    sub.on("message", (channel, payload) => {
      if (channel === MODERATION_EVENT_CHANNEL) {
        this.onModerationEvent(payload);
        return;
      }
      const cid = parseCanvasDeltaChannel(channel);
      if (cid !== null) {
        // R2 optim: if no local conn is on this canvas, drop the delta early.
        const state = this.canvasStates.get(cid);
        if (!state) return;
        const d = parseDeltaMessage(payload);
        if (!d) return;
        state.coalescer.add(d);
        state.ring.push(d);
      }
    });
    // Reset all per-canvas rings on Redis reconnect: a subscriber outage may
    // have dropped writes, so replay must fall back to a snapshot not an
    // incomplete tail.
    sub.on("ready", () => {
      for (const state of this.canvasStates.values()) state.ring.reset();
    });
    // Per-canvas delta channels are subscribed lazily as clients connect (see
    // ensureCanvasSubscribed). Only the cross-instance moderation channel is
    // always-on (FEN-156): it must reach viewers even before the first client.
    await sub.subscribe(MODERATION_EVENT_CHANNEL);
  }

  /**
   * Subscribe to the per-canvas delta channel on first connection for that
   * canvas and create its coalescer+ring. Resolves the canvas's durable dims
   * from Convex (FEN-1762) before creating the coalescer so its offset
   * arithmetic uses the correct width (not the global env default).
   *
   * Idempotency: after the async dims resolve we re-check canvasStates so that
   * a second concurrent call (same canvas, overlapping event-loop ticks) does
   * not overwrite the entry the first call already set (JS single-thread:
   * only one microtask runs between awaits, so the re-check is race-free).
   */
  async ensureCanvasSubscribed(canvasId: string): Promise<void> {
    if (this.canvasStates.has(canvasId)) return;

    // Resolve durable dims (fallback to env on any failure). The cache
    // deduplicates concurrent fetches for the same canvas.
    const dims = await this.dimsCache.resolve(canvasId);

    // Re-check after the await: a concurrent call may have already set the entry.
    if (this.canvasStates.has(canvasId)) return;

    this.canvasStates.set(canvasId, {
      coalescer: new DeltaCoalescer(dims.width),
      ring: new SeqRingBuffer(this.cfg.resyncBufferSize),
      dims,
    });
    try {
      await this.redis.sub.subscribe(canvasDeltaChannel(canvasId));
    } catch (err) {
      console.warn(`[gateway] subscribe canvas ${canvasId} failed: ${(err as Error).message}`);
      this.canvasStates.delete(canvasId);
    }
  }

  /**
   * Unsubscribe and reap per-canvas state when the last client for that canvas
   * disconnects (R1 memory bound). Called after removing the connection from
   * clients so the scan is accurate.
   */
  reapCanvasIfEmpty(canvasId: string): void {
    for (const c of this.clients) {
      if (c.canvasId === canvasId) return;
    }
    this.canvasStates.delete(canvasId);
    void this.redis.sub
      .unsubscribe(canvasDeltaChannel(canvasId))
      .catch((err) =>
        console.warn(`[gateway] unsubscribe canvas ${canvasId} failed: ${(err as Error).message}`),
      );
  }

  /** Emit one coalesced delta frame per canvas to that canvas's clients (CA1 fan-out). */
  flush(): void {
    for (const [canvasId, state] of this.canvasStates) {
      const batch = state.coalescer.flush();
      if (!batch) continue;
      const frame = Buffer.from(encodeDelta(batch.seq, batch.writes));
      for (const c of this.clients) {
        if (c.canvasId === canvasId) c.sendBinary(frame);
      }
    }
  }

  async refreshPresence(): Promise<void> {
    try {
      await writePresence(this.redis.cmd, this.cfg.instanceId, this.clients.size, this.cfg.presenceTtlMs);
      const total = await readGlobalViewerCount(this.redis.cmd);
      if (total !== this.lastViewerCount) {
        this.lastViewerCount = total;
        this.broadcastJson({ t: "viewerCount", count: total });
      }
    } catch (err) {
      console.warn(`[gateway] presence refresh failed: ${(err as Error).message}`);
    }
  }

  heartbeat(): void {
    for (const c of this.clients) {
      if (!c.isAlive) {
        c.ws.terminate();
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }

  broadcastJson(msg: ServerMessage): void {
    for (const c of this.clients) c.sendJson(msg);
  }

  /**
   * Re-broadcast a fanned-out moderation event (FEN-156) as a `moderationEvent`
   * frame to all connections viewing the affected canvas. A malformed payload is
   * dropped (parse → null), never crashing the subscription.
   */
  private onModerationEvent(payload: string): void {
    const ev = parseModerationEvent(payload);
    if (!ev) return;
    const frame = { t: "moderationEvent" as const, version: ev.version, cells: ev.cells };
    for (const c of this.clients) {
      if (c.canvasId === ev.canvasId) c.sendJson(frame);
    }
  }
}
