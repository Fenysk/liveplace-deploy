/**
 * Internal HTTP route handlers for the gateway (G1 — FEN-1947).
 *
 * Covers:
 *   - /internal/* moderation seam (F8/FEN-19)
 *   - POST /internal/gauge/claim
 *   - GET /r, /r/report (outreach funnel attribution, FEN-242)
 */
import { type IncomingMessage, type ServerResponse } from "node:http";
import { encodeSnapshot, PALETTE_SIZE } from "@canvas/protocol";
import {
  DEFAULT_CANVAS_ID,
  flushRequestChannel,
  GRID_RESIZE_LUA,
  resizeGridArgs,
  parseResizeGridResult,
  type GaugeParams,
} from "@canvas/redis-scripts";
import type { GatewayConfig } from "./config";
import { ModerationService, IoredisModerationRedis, ModerationRequestError, parseCells } from "./moderation";
import { PurgeUserService, parsePurgeUserBody, type PurgeUserResult } from "./purgeUser";
import {
  IoredisGaugeGrantRunner,
  IoredisGaugePeekRunner,
  type GaugeGrantRunner,
  type GaugePeekRunner,
} from "./gaugeBonus";
import { DeltaCoalescer } from "./coalescer";
import { evalShaCached, type CachedScript } from "./evalsha";
import {
  AttributionStore,
  buildRefCookie,
  sanitizeRef,
} from "./attribution";
import { readCanvasSnapshot, type RedisPair } from "./redis";
import { gaugeFrame } from "./frames";
import { CanvasDimsCache } from "./canvasDims";
import type { CanvasState } from "./pubsub";
import type { Connection } from "./connection";

export class InternalRoutesHandler {
  private readonly gaugeGrant: GaugeGrantRunner;
  private readonly gaugePeek: GaugePeekRunner;
  private readonly attribution: AttributionStore;
  private readonly gridResizeScript: CachedScript;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly dimsCache: CanvasDimsCache,
    private readonly redis: RedisPair,
    private readonly clients: Set<Connection>,
    private readonly canvasStates: Map<string, CanvasState>,
  ) {
    this.gaugeGrant = new IoredisGaugeGrantRunner(redis.cmd);
    this.gaugePeek = new IoredisGaugePeekRunner(redis.cmd);
    this.attribution = new AttributionStore(redis.cmd);
    this.gridResizeScript = evalShaCached(redis.cmd, GRID_RESIZE_LUA);
  }

  /**
   * Plain-HTTP routes: a health probe for the proxy/compose healthcheck, plus the
   * moderation and gauge-claim seams.
   */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    // Outreach funnel attribution (FEN-242): public tracked redirect + a
    // secret-guarded JSON report. Both are GET; everything else falls through.
    if (req.method === "GET" && path === "/r") {
      this.handleAttributionVisit(req, res);
      return;
    }
    if (req.method === "GET" && path === "/r/report") {
      await this.handleAttributionReport(req, res);
      return;
    }
    // Moderation internal seam (F8/FEN-19, docs/contracts/moderation-internal.md).
    if (req.method === "POST" && path.startsWith("/internal/")) {
      const handler =
        path === "/internal/moderate" ? this.handleModerate
        : path === "/internal/ban" ? this.handleBan
        : path === "/internal/freeze" ? this.handleFreeze
        : path === "/internal/flush" ? this.handleFlush
        : path === "/internal/gauge/claim" ? this.handleGaugeClaim
        : path === "/internal/dims/invalidate" ? this.handleDimsInvalidate
        : path === "/internal/grid/resize" ? this.handleGridResize
        : path === "/internal/purge-user" ? this.handlePurgeUser
        : undefined;
      if (handler) {
        await this.handleModerationRoute(req, res, handler.bind(this));
        return;
      }
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  }

  /**
   * Shared envelope for the moderation routes: enforce the Bearer secret, parse
   * the JSON body, run the per-route handler and serialise its result. A missing
   * GATEWAY_INTERNAL_SECRET disables the whole seam (404), mirroring the gauge
   * refresh route — so a misconfigured gateway never silently accepts moderation.
   */
  private async handleModerationRoute(
    req: IncomingMessage,
    res: ServerResponse,
    handler: (body: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const secret = this.cfg.internalSecret;
    if (!secret) {
      res.writeHead(404).end("moderation seam disabled");
      return;
    }
    if (req.headers["authorization"] !== `Bearer ${secret}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: Record<string, unknown>;
    try {
      parsed = (JSON.parse(body || "{}") as Record<string, unknown>) ?? {};
    } catch {
      res.writeHead(400).end("malformed body");
      return;
    }
    try {
      const result = await handler(parsed);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ?? {}));
    } catch (err) {
      const msg = (err as Error).message;
      // A bad request (validation) is the caller's fault → 400; anything else is ours.
      const bad = err instanceof ModerationRequestError;
      res.writeHead(bad ? 400 : 500).end(msg);
      if (!bad) console.warn(`[gateway] moderation route failed: ${msg}`);
    }
  }

  /**
   * Build a `ModerationService` scoped to the given canvas (S2/FEN-1564). The
   * service is stateless — all mutable state lives in Redis — so constructing one
   * per request is cheap and avoids a shared-instance canvasId mix-up.
   */
  private moderationFor(canvasId: string): ModerationService {
    const dims = this.dimsCache.getDimsOrFallback(canvasId);
    return new ModerationService(new IoredisModerationRedis(this.redis.cmd), {
      canvasId,
      width: dims.width,
      height: dims.height,
      paletteSize: PALETTE_SIZE,
    });
  }

  /**
   * Extract the target `canvasId` from the request body (S2/FEN-1564). Convex
   * passes the canvas it authorised the action on; fall back to the gateway's
   * own canvas for older callers that have not yet been updated.
   */
  private canvasIdFromBody(body: Record<string, unknown>): string {
    if (typeof body.canvasId === "string" && body.canvasId) return body.canvasId;
    // FEN-1933: this fallback silently rerouted every slug-only moderation
    // dispatch to the default canvas (a dead namespace since FEN-1613). All
    // Convex callers now send `canvasId`; keep the fallback for local
    // single-canvas smoke but make any production hit loud.
    const fallback = this.cfg.canvasId ?? DEFAULT_CANVAS_ID;
    console.warn(
      `[gateway] internal route body missing canvasId (slug=${String(body.slug ?? "?")}) — falling back to ${fallback}`,
    );
    return fallback;
  }

  /** `POST /internal/moderate` — apply a Convex-decided bulk overwrite; echo {version}. */
  private async handleModerate(body: Record<string, unknown>): Promise<{ applied: number; version: number }> {
    const cells = parseCells(body.cells);
    const { applied, version } = await this.moderationFor(this.canvasIdFromBody(body)).moderate(cells);
    return { applied, version };
  }

  /** `POST /internal/ban` — (un)ban a user on the hot path (CA6). */
  private async handleBan(body: Record<string, unknown>): Promise<{ banned: boolean }> {
    const userId = body.userId;
    if (typeof userId !== "string" || userId === "") {
      throw new ModerationRequestError("missing userId");
    }
    const banned = body.banned !== false; // default to banning unless explicitly false
    await this.moderationFor(this.canvasIdFromBody(body)).setBan(userId, banned);
    return { banned };
  }

  /** `POST /internal/freeze` — emergency freeze/unfreeze toggle (F8.4/CA4). */
  private async handleFreeze(body: Record<string, unknown>): Promise<{ frozen: boolean }> {
    const frozen = body.frozen === true;
    await this.moderationFor(this.canvasIdFromBody(body)).setFrozen(frozen);
    return { frozen };
  }

  /** `POST /internal/flush` — best-effort nudge to drain the stream before a mass action. */
  private async handleFlush(body: Record<string, unknown>): Promise<{ requested: boolean; awaited: boolean }> {
    const requested = await this.moderationFor(this.canvasIdFromBody(body)).requestFlush();
    // awaited=false: the gateway cannot synchronously await the worker's drain
    // across processes; durability does not depend on it (see ModerationService).
    return { requested, awaited: false };
  }

  /**
   * `POST /internal/purge-user` — erase every Redis key referencing a user as
   * part of account deletion (FEN-1966, C-4 §3c/§3d). User-scoped, not
   * canvas-scoped, so it bypasses `moderationFor`; see purgeUser.ts for the
   * exact key inventory. Idempotent — Convex re-runs it on a retried deletion.
   */
  private async handlePurgeUser(body: Record<string, unknown>): Promise<PurgeUserResult> {
    return new PurgeUserService(this.redis.cmd).purgeUser(parsePurgeUserBody(body));
  }

  /**
   * `POST /internal/gauge/claim` — the tier-claim seam (Lot D / FEN-130). Convex
   * has already applied the durable `gaugeMaxBonus += 1` and computed how many
   * charges to hand out (`charges`, board default 1). The gateway: (1) re-reads
   * the bonus so the effective max reflects the just-applied claim, (2) grants
   * the charges to the live gauge atomically, (3) pushes a `gauge` frame so the
   * réserve grows in step with the celebration even mid-cooldown. Best-effort by
   * the same logic as moderation/refresh: if the user has no live socket here the
   * raised max simply takes effect on their next placement/reconnect.
   */
  private async handleGaugeClaim(
    body: Record<string, unknown>,
  ): Promise<{ refreshed: number; granted: boolean }> {
    const userId = body.userId;
    if (typeof userId !== "string" || userId === "") {
      throw new ModerationRequestError("missing userId");
    }
    const raw = body.charges;
    // Default to the board's +1; coerce to a non-negative integer (0 ⇒ pure
    // refresh, e.g. a no-op replay confirming an already-applied tier).
    const grant =
      raw === undefined ? 1 : typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    // The tier was claimed on a specific canvas (FEN-1616) — Convex now threads
    // `canvasId` in the body so the grant lands on that canvas's gauge only, not
    // on every canvas the user happens to have open.
    return this.grantUserCharge(userId, this.canvasIdFromBody(body), grant);
  }

  /**
   * Evict a canvas's dims from the in-process cache AND broadcast a `dimsChanged`
   * frame to all currently-connected clients so they re-render in real time
   * without waiting for a reconnect. Called by Convex immediately after a
   * successful `updateCanvasConfig` resize (FEN-1790).
   * `width` and `height` are optional — when present the in-memory canvasStates
   * dims are updated and the broadcast is sent; when absent (legacy callers) only
   * the cache eviction runs.
   */
  private async handleDimsInvalidate(body: Record<string, unknown>): Promise<{ ok: boolean; broadcast: number }> {
    const canvasId = body.canvasId;
    if (typeof canvasId !== "string" || canvasId === "") {
      throw new ModerationRequestError("missing canvasId");
    }
    const width = body.width;
    const height = body.height;
    if (typeof width !== "number" || typeof height !== "number") {
      // No new dims known — evict so next resolve fetches fresh data from Convex.
      this.dimsCache.invalidate(canvasId);
      return { ok: true, broadcast: 0 };
    }
    // Dims are known — update the cache directly so getDimsIfReady never
    // returns null after the invalidation (FEN-1813).
    this.dimsCache.set(canvasId, { width, height });

    // Update the in-memory canvasStates so that any future welcome/snapshot
    // sent from an existing state entry uses the correct geometry.
    const state = this.canvasStates.get(canvasId);
    if (state) state.dims = { width, height };

    // Push the new dims to every live connection on this canvas.
    let broadcast = 0;
    for (const c of this.clients) {
      if (c.canvasId === canvasId) {
        c.sendJson({ t: "dimsChanged", width, height });
        broadcast++;
      }
    }
    return { ok: true, broadcast };
  }

  /**
   * `POST /internal/grid/resize` — atomically relayout the Redis pixel buffer to
   * the new canvas geometry, flush the in-process ring + coalescer, and resync
   * every live client (C-B contract, FEN-1802/S2).
   *
   * Sequence (must stay in this order):
   * 1. Read old dims (prefer in-memory canvasStates, fall back to dimsCache)
   *    BEFORE invalidating, so grid-resize.lua gets the correct old stride.
   * 2. Run grid-resize.lua atomically: GET + row-wise copy + SET (R2).
   * 3. Invalidate dims cache; update canvasStates dims, ring, and coalescer so
   *    future snapshots/welcomes use the new geometry and old deltas are purged.
   * 4. Broadcast `dimsChanged { width, height }` followed immediately by a
   *    fresh binary snapshot to every live connection — full resync, no delta
   *    cross-layout (C-C).
   * 5. Publish a flush-nudge so the worker drains + snapshots the new layout.
   */
  private async handleGridResize(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; surviving: number; broadcast: number; resynced: number }> {
    const canvasId = body.canvasId;
    if (typeof canvasId !== "string" || canvasId === "") {
      throw new ModerationRequestError("missing canvasId");
    }
    const width = body.width;
    const height = body.height;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      throw new ModerationRequestError("invalid width");
    }
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
      throw new ModerationRequestError("invalid height");
    }
    const newW = Math.floor(width);
    const newH = Math.floor(height);

    // Step 1: Read old dims BEFORE the invalidation (preserves pre-resize stride
    // for the Lua).  canvasStates.dims is the most accurate source when clients
    // are connected; fall back to dimsCache for cold canvases.
    const stateEntry = this.canvasStates.get(canvasId);
    const old = stateEntry?.dims ?? this.dimsCache.getDimsOrFallback(canvasId);

    // Step 2: Atomic row-wise relayout of the Redis pixel buffer.
    const { keys, argv } = resizeGridArgs({
      canvasId,
      oldWidth: old.width,
      oldHeight: old.height,
      newWidth: newW,
      newHeight: newH,
    });
    const raw = await this.gridResizeScript.run(keys, argv);
    const { surviving } = parseResizeGridResult(raw);

    // Step 3: Update cache with new dims; rebuild in-process ring + coalescer
    // so old deltas (encoded at the old stride) are never served as incremental
    // replay.  Use set() rather than invalidate() so getDimsIfReady never
    // returns null — a null would cause the placement handler to reject the
    // very next pixel placement with "canvas not ready" (FEN-1813).
    this.dimsCache.set(canvasId, { width: newW, height: newH });
    if (stateEntry) {
      stateEntry.dims = { width: newW, height: newH };
      stateEntry.ring.reset();
      stateEntry.coalescer = new DeltaCoalescer(newW);
    }

    // Step 4: Broadcast dimsChanged + fresh snapshot to every live connection
    // on this canvas.  The snapshot is read once and shared (one Redis call).
    let broadcast = 0;
    let resynced = 0;
    const conns = [...this.clients].filter((c) => c.canvasId === canvasId);
    if (conns.length > 0) {
      broadcast = conns.length;
      let snapBuf: Buffer | null = null;
      try {
        const snap = await readCanvasSnapshot(this.redis.cmd, canvasId, newW, newH);
        snapBuf = Buffer.from(encodeSnapshot(snap.pixels, snap.seq, newW, newH));
      } catch (err) {
        console.warn(`[gateway] grid/resize: snapshot read failed for ${canvasId}: ${(err as Error).message}`);
      }
      for (const c of conns) {
        c.sendJson({ t: "dimsChanged", width: newW, height: newH });
        if (snapBuf) {
          c.sendBinary(snapBuf);
          resynced++;
        }
      }
    }

    // Step 5: Nudge the worker to drain + record a fresh snapshot at the new dims.
    try {
      await (this.redis.cmd as unknown as { publish(ch: string, msg: string): Promise<unknown> }).publish(
        flushRequestChannel(canvasId),
        "resize",
      );
    } catch {
      // best-effort
    }

    console.log(
      `[gateway] grid/resize canvas=${canvasId} ${old.width}x${old.height}→${newW}x${newH} ` +
        `surviving=${surviving} broadcast=${broadcast} resynced=${resynced}`,
    );
    return { ok: true, surviving, broadcast, resynced };
  }

  /**
   * Hand `grant` charges to a user's live gauge ON `canvasId` and push the
   * post-grant `gauge` frame to every socket of theirs on that canvas. The grant
   * hits the per-(canvas, user) gauge hash exactly once (not once per socket),
   * then the resulting snapshot fans out to that canvas's connections so multi-tab
   * viewers stay consistent. Sockets the user has open on OTHER canvases are
   * untouched — their gauges are independent buckets (FEN-1616).
   */
  async grantUserCharge(
    userId: string,
    canvasId: string,
    grant: number,
  ): Promise<{ refreshed: number; granted: boolean }> {
    const conns = [...this.clients].filter((c) => c.user.userId === userId && c.canvasId === canvasId);
    if (conns.length === 0) return { refreshed: 0, granted: false };

    // Re-resolve the bonus per connection so the effective max reflects the claim
    // Convex just applied; take the highest in case a socket's resolve lagged.
    let effMax = this.cfg.gauge.base.gaugeMax;
    for (const c of conns) {
      try {
        await c.gauge.refresh();
      } catch (err) {
        console.warn(`[gateway] gauge refresh (claim) failed for ${userId}: ${(err as Error).message}`);
      }
      effMax = Math.max(effMax, c.gauge.effectiveGaugeMax);
    }

    const gaugeParams: GaugeParams = { ...this.cfg.gauge.base, gaugeMax: effMax };
    let snapshot;
    try {
      snapshot = await this.gaugeGrant.grant(userId, canvasId, gaugeParams, grant, Date.now());
    } catch (err) {
      console.warn(`[gateway] gauge grant failed for ${userId}: ${(err as Error).message}`);
      return { refreshed: conns.length, granted: false };
    }

    for (const c of conns) {
      c.sendJson(gaugeFrame(snapshot));
    }
    return { refreshed: conns.length, granted: true };
  }

  /**
   * `GET /r?ref=XYZ` — outreach funnel VISIT (FEN-242). Counts the click, drops
   * the short first-party `lp_ref` cookie so a later authenticated WS upgrade can
   * attribute the signup, then 302s to the public site. UI-independent: the DM
   * link points straight here, no frontend. A missing/invalid ref still
   * redirects (we just don't attribute it).
   */
  private handleAttributionVisit(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ref = sanitizeRef(url.searchParams.get("ref"));
    const headers: Record<string, string> = {
      location: this.cfg.attribution.redirectUrl,
    };
    if (ref) {
      headers["set-cookie"] = buildRefCookie(ref, {
        maxAgeSec: this.cfg.attribution.cookieMaxAgeSec,
        secure: this.cfg.attribution.cookieSecure,
      });
      // Fire-and-forget: never let a Redis blip delay the visitor's redirect.
      void this.attribution
        .recordVisit(ref)
        .catch((err) => console.warn(`[gateway] attribution visit failed: ${(err as Error).message}`));
    }
    res.writeHead(302, headers).end();
  }

  /**
   * `GET /r/report` — outreach funnel REPORT (FEN-242). Visits + signups per ref
   * as JSON for the CMO. Guarded by the same Bearer `internalSecret` as the
   * moderation seam; unset ⇒ 404 (route disabled), mirroring those routes.
   */
  private async handleAttributionReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = this.cfg.internalSecret;
    if (!secret) {
      res.writeHead(404).end("attribution report disabled");
      return;
    }
    if (req.headers["authorization"] !== `Bearer ${secret}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    try {
      const rows = await this.attribution.report();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rows }));
    } catch (err) {
      const msg = (err as Error).message;
      res.writeHead(500).end(msg);
      console.warn(`[gateway] attribution report failed: ${msg}`);
    }
  }

}
