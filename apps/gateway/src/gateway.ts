/**
 * The WebSocket gateway. Responsibilities (F7 / FEN-13):
 *   - authenticate each socket by JWT at upgrade time (CA3);
 *   - serve initial canvas state, then fan out coalesced deltas to every
 *     socket from a single Redis subscription with no per-socket DB reads (CA1);
 *   - resynchronise a reconnecting client incrementally by seq, falling back to
 *     a snapshot when it has fallen too far behind (CA2);
 *   - track and broadcast a global viewer count across instances (CA4).
 *
 * Business validation of placements (gauge/cooldown/bans) is explicitly out of
 * scope here — it belongs to F4/F5. A PlacementHandler hook is exposed so that
 * work can plug in without touching the transport.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeJson,
  encodeDelta,
  encodeJson,
  encodeSnapshot,
  PALETTE_SIZE,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PixelWrite,
  type ServerMessage,
} from "@canvas/protocol";
import { DELTA_CHANNEL, DEFAULT_CANVAS_ID, type GaugeParams } from "@canvas/redis-scripts";
import { parseDeltaMessage, parseModerationEvent, MODERATION_EVENT_CHANNEL } from "./schema";
import type { GatewayConfig } from "./config";
import { ModerationService, IoredisModerationRedis, ModerationRequestError, parseCells } from "./moderation";
import { createAuthenticator, AuthError, type AuthedUser, type SocketAuthenticator } from "./auth";
import {
  SessionGauge,
  StaticGaugeBonusSource,
  IoredisGaugeGrantRunner,
  IoredisGaugePeekRunner,
  type GaugeBonusSource,
  type GaugeGrantRunner,
  type GaugePeekRunner,
} from "./gaugeBonus";
import { DeltaCoalescer } from "./coalescer";
import { SeqRingBuffer } from "./ringBuffer";
import { TokenBucket } from "./rateLimiter";
import {
  clearPresence,
  createRedisPair,
  readCanvasSnapshot,
  readGlobalViewerCount,
  writePresence,
  type RedisPair,
} from "./redis";

/** Per-socket state the gateway tracks. */
export class Connection {
  isAlive = true;
  constructor(
    readonly ws: WebSocket,
    readonly user: AuthedUser,
    /**
     * Per-session gauge resolution (F6/FEN-27): caches the user's durable
     * gauge-max bonus and exposes the effective max the placement path (F5)
     * passes to place-pixel. The placement handler reads `conn.gauge.effectiveGaugeMax`.
     */
    readonly gauge: SessionGauge,
    /**
     * Per-socket inbound-message rate limiter (G-I2). Bounds the raw message
     * rate before any validation/Redis work, independent of the gauge. Optional
     * so non-gateway constructions (tests) need not supply one.
     */
    readonly limiter?: TokenBucket,
  ) {}

  sendJson(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeJson(msg));
  }

  sendBinary(frame: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame, { binary: true });
  }
}

/**
 * Hook for F4: validate + perform a placement. The default rejects, so until
 * F4 lands the transport behaves correctly (clients get a clear error) without
 * a fake success path.
 */
export interface PlacementHandler {
  handlePlace(conn: Connection, msg: Extract<ClientMessage, { t: "place" }>): Promise<void>;
}

const rejectingPlacementHandler: PlacementHandler = {
  async handlePlace(conn, msg) {
    conn.sendJson({
      t: "error",
      code: "internal",
      message: "placement not enabled yet (pending F4 validation)",
      cid: msg.cid,
    });
  },
};

export class Gateway {
  private readonly redis: RedisPair;
  private readonly auth: SocketAuthenticator;
  private readonly clients = new Set<Connection>();
  private readonly coalescer: DeltaCoalescer;
  private readonly ring: SeqRingBuffer;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly moderation: ModerationService;
  /** Atomic charge-grant on the live gauge for the tier-claim seam (FEN-130). */
  private readonly gaugeGrant: GaugeGrantRunner;
  /** Read-only gauge snapshot for the initial `gauge` frame on connect (FEN-184). */
  private readonly gaugePeek: GaugePeekRunner;

  private flushTimer?: ReturnType<typeof setInterval>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastBroadcastViewerCount = -1;
  private stopped = false;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly placement: PlacementHandler = rejectingPlacementHandler,
    redis?: RedisPair,
    /**
     * Source of the durable F6 gauge-max bonus. Defaults to a static-zero source
     * (everyone gets the canvas base max) so local smoke works with no Convex;
     * the entrypoint injects a Convex-backed source when configured.
     */
    private readonly bonusSource: GaugeBonusSource = new StaticGaugeBonusSource(0),
  ) {
    this.redis = redis ?? createRedisPair(cfg.redisUrl);
    this.auth = createAuthenticator(cfg.auth);
    this.coalescer = new DeltaCoalescer(cfg.width);
    this.ring = new SeqRingBuffer(cfg.resyncBufferSize);
    this.http = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.moderation = new ModerationService(new IoredisModerationRedis(this.redis.cmd), {
      canvasId: cfg.canvasId ?? DEFAULT_CANVAS_ID,
      width: cfg.width,
      height: cfg.height,
      paletteSize: PALETTE_SIZE,
    });
    this.gaugeGrant = new IoredisGaugeGrantRunner(this.redis.cmd);
    this.gaugePeek = new IoredisGaugePeekRunner(this.redis.cmd);
    this.wireUpgrade();
  }

  /**
   * Plain-HTTP routes: a health probe for the proxy/compose healthcheck, plus an
   * optional secret-gated endpoint to refresh a user's gauge bonus mid-session
   * after a `purchaseGaugeUpgrade` (FEN-27 #3). Without a configured secret only
   * the health route exists and purchases take effect on the next reconnect.
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path === "/internal/gauge/refresh") {
      await this.handleGaugeRefresh(req, res);
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

  /** `POST /internal/moderate` — apply a Convex-decided bulk overwrite; echo {version}. */
  private async handleModerate(body: Record<string, unknown>): Promise<{ applied: number; version: number }> {
    const cells = parseCells(body.cells);
    const { applied, version } = await this.moderation.moderate(cells);
    return { applied, version };
  }

  /** `POST /internal/ban` — (un)ban a user on the hot path (CA6). */
  private async handleBan(body: Record<string, unknown>): Promise<{ banned: boolean }> {
    const userId = body.userId;
    if (typeof userId !== "string" || userId === "") {
      throw new ModerationRequestError("missing userId");
    }
    const banned = body.banned !== false; // default to banning unless explicitly false
    await this.moderation.setBan(userId, banned);
    return { banned };
  }

  /** `POST /internal/freeze` — emergency freeze/unfreeze toggle (F8.4/CA4). */
  private async handleFreeze(body: Record<string, unknown>): Promise<{ frozen: boolean }> {
    const frozen = body.frozen === true;
    await this.moderation.setFrozen(frozen);
    return { frozen };
  }

  /** `POST /internal/flush` — best-effort nudge to drain the stream before a mass action. */
  private async handleFlush(): Promise<{ requested: boolean; awaited: boolean }> {
    const requested = await this.moderation.requestFlush();
    // awaited=false: the gateway cannot synchronously await the worker's drain
    // across processes; durability does not depend on it (see ModerationService).
    return { requested, awaited: false };
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
    return this.grantUserCharge(userId, grant);
  }

  /**
   * Hand `grant` charges to a user's live gauge and push the post-grant `gauge`
   * frame to every socket of theirs. The grant hits the SHARED per-user gauge
   * hash exactly once (not once per socket), then the resulting snapshot fans out
   * to all the user's connections so multi-tab viewers stay consistent.
   */
  async grantUserCharge(userId: string, grant: number): Promise<{ refreshed: number; granted: boolean }> {
    const conns = [...this.clients].filter((c) => c.user.userId === userId);
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
      snapshot = await this.gaugeGrant.grant(userId, gaugeParams, grant, Date.now());
    } catch (err) {
      console.warn(`[gateway] gauge grant failed for ${userId}: ${(err as Error).message}`);
      return { refreshed: conns.length, granted: false };
    }

    for (const c of conns) {
      c.sendJson({
        t: "gauge",
        charges: snapshot.charges,
        max: snapshot.max,
        cooldownUntil: snapshot.cooldownUntil,
      });
    }
    return { refreshed: conns.length, granted: true };
  }

  private async handleGaugeRefresh(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const secret = this.cfg.gauge.refreshSecret;
    if (!secret) {
      res.writeHead(404).end("gauge refresh disabled");
      return;
    }
    if (req.headers["x-gauge-refresh-secret"] !== secret) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let userId: unknown;
    try {
      ({ userId } = JSON.parse(body || "{}") as { userId?: unknown });
    } catch {
      res.writeHead(400).end("malformed body");
      return;
    }
    if (typeof userId !== "string" || userId === "") {
      res.writeHead(400).end("missing userId");
      return;
    }
    const refreshed = await this.refreshUserGauge(userId);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refreshed }));
  }

  /** Re-resolve the bonus for every live connection of a user; returns how many. */
  async refreshUserGauge(userId: string): Promise<number> {
    let refreshed = 0;
    for (const c of this.clients) {
      if (c.user.userId !== userId) continue;
      refreshed++;
      try {
        await c.gauge.refresh();
      } catch (err) {
        console.warn(`[gateway] gauge refresh failed for ${userId}: ${(err as Error).message}`);
      }
    }
    return refreshed;
  }

  /** The actual TCP port the gateway is listening on (useful with port 0 in tests). */
  get boundPort(): number {
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : this.cfg.port;
  }

  async start(): Promise<void> {
    await this.subscribeDeltas();
    this.flushTimer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
    this.presenceTimer = setInterval(() => void this.refreshPresence(), this.cfg.presenceRefreshMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.cfg.heartbeatMs);
    await new Promise<void>((resolve) => this.http.listen(this.cfg.port, resolve));
    console.log(
      `[gateway] instance=${this.cfg.instanceId} listening on :${this.cfg.port} ` +
        `(canvas ${this.cfg.width}x${this.cfg.height}, flush=${this.cfg.flushIntervalMs}ms)`,
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.flushTimer);
    clearInterval(this.presenceTimer);
    clearInterval(this.heartbeatTimer);
    for (const c of this.clients) c.ws.close(1001, "server shutting down");
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    try {
      await clearPresence(this.redis.cmd, this.cfg.instanceId);
    } catch {
      /* best effort */
    }
    this.redis.cmd.disconnect();
    this.redis.sub.disconnect();
    console.log("[gateway] stopped");
  }

  // ── Redis delta subscription ───────────────────────────────────────────────

  private async subscribeDeltas(): Promise<void> {
    const { sub } = this.redis;
    sub.on("message", (channel, payload) => {
      if (channel === DELTA_CHANNEL) {
        const d = parseDeltaMessage(payload);
        if (!d) return;
        this.coalescer.add(d);
        this.ring.push(d);
        return;
      }
      if (channel === MODERATION_EVENT_CHANNEL) {
        this.onModerationEvent(payload);
        return;
      }
    });
    // A reconnect may have dropped writes → the ring could have a gap. Reset it
    // so resync falls back to a snapshot rather than serving an incomplete tail.
    sub.on("ready", () => this.ring.reset());
    await sub.subscribe(DELTA_CHANNEL);
    // FEN-156: action-level moderation events fan out cross-instance just like
    // deltas, so a viewer on ANY instance gets the wipe attribution.
    await sub.subscribe(MODERATION_EVENT_CHANNEL);
  }

  /**
   * Re-broadcast a fanned-out moderation event (FEN-156) as a `moderationEvent`
   * frame to this instance's viewers. Filtered to this gateway's canvas so a
   * future multi-canvas deployment only notifies the affected viewers; for the
   * single-canvas MVP it always matches. A malformed payload is dropped (parse →
   * null), never crashing the subscription.
   */
  private onModerationEvent(payload: string): void {
    const ev = parseModerationEvent(payload);
    if (!ev) return;
    if (ev.canvasId !== (this.cfg.canvasId ?? DEFAULT_CANVAS_ID)) return;
    this.broadcastJson({ t: "moderationEvent", version: ev.version, cells: ev.cells });
  }

  /** Emit one coalesced delta frame to every client (the CA1 fan-out). */
  private flush(): void {
    const batch = this.coalescer.flush();
    if (!batch) return;
    const frame = Buffer.from(encodeDelta(batch.seq, batch.writes));
    for (const c of this.clients) c.sendBinary(frame);
  }

  // ── Presence ────────────────────────────────────────────────────────────────

  private async refreshPresence(): Promise<void> {
    try {
      await writePresence(this.redis.cmd, this.cfg.instanceId, this.clients.size, this.cfg.presenceTtlMs);
      const total = await readGlobalViewerCount(this.redis.cmd);
      if (total !== this.lastBroadcastViewerCount) {
        this.lastBroadcastViewerCount = total;
        this.broadcastJson({ t: "viewerCount", count: total });
      }
    } catch (err) {
      console.warn(`[gateway] presence refresh failed: ${(err as Error).message}`);
    }
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.isAlive) {
        c.ws.terminate();
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }

  private broadcastJson(msg: ServerMessage): void {
    for (const c of this.clients) c.sendJson(msg);
  }

  // ── Upgrade + per-connection lifecycle ───────────────────────────────────────

  private wireUpgrade(): void {
    this.http.on("upgrade", (req, socket, head) => {
      void this.authenticateUpgrade(req)
        .then((user) => {
          this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user));
        })
        .catch((err) => {
          const reason = err instanceof AuthError ? err.message : "internal error";
          socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${reason}`);
          socket.destroy();
        });
    });
  }

  private async authenticateUpgrade(req: IncomingMessage): Promise<AuthedUser> {
    const token = extractToken(req);
    return this.auth.authenticate(token);
  }

  private onConnection(ws: WebSocket, user: AuthedUser): void {
    const gauge = new SessionGauge(this.bonusSource, user.userId, this.cfg.gauge.base.gaugeMax);
    const limiter = new TokenBucket(
      this.cfg.socket.inboundBurst,
      this.cfg.socket.inboundRefillPerSec,
      Date.now(),
    );
    const conn = new Connection(ws, user, gauge, limiter);
    this.clients.add(conn);

    // Resolve the durable F6 bonus for this session (FEN-27 #1). It starts at the
    // base max and lifts to base+bonus once Convex answers; a transient failure
    // just leaves the user at base for this session (logged, never fatal).
    // Anonymous viewers never place, so there is nothing to resolve — skip it.
    if (user.userId !== null) {
      void gauge.refresh().catch((err) => {
        console.warn(`[gateway] gauge bonus resolve failed for ${user.userId}: ${(err as Error).message}`);
      });
    }

    ws.on("pong", () => {
      conn.isAlive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // protocol: clients speak JSON text frames only
      void this.onClientMessage(conn, data.toString());
    });
    ws.on("close", () => {
      this.clients.delete(conn);
    });
    ws.on("error", () => {
      this.clients.delete(conn);
    });

    void this.sendInitialState(conn);
  }

  /** welcome → snapshot → current viewer count. */
  private async sendInitialState(conn: Connection): Promise<void> {
    try {
      const snap = await readCanvasSnapshot(this.redis.cmd, this.cfg.canvasId ?? DEFAULT_CANVAS_ID, this.cfg.width, this.cfg.height);
      conn.sendJson({
        t: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        width: this.cfg.width,
        height: this.cfg.height,
        cooldownUntil: 0, // gauge state is F4/F5; transport reports "ready".
        seq: snap.seq,
      });
      conn.sendBinary(Buffer.from(encodeSnapshot(snap.pixels, snap.seq, this.cfg.width, this.cfg.height)));
      if (this.lastBroadcastViewerCount >= 0) {
        conn.sendJson({ t: "viewerCount", count: this.lastBroadcastViewerCount });
      }
      await this.sendInitialGauge(conn);
    } catch (err) {
      console.warn(`[gateway] failed to send initial state: ${(err as Error).message}`);
      conn.sendJson({ t: "error", code: "internal", message: "could not load canvas" });
      conn.ws.close(1011, "initial state failed");
    }
  }

  /**
   * Push the viewer's CURRENT gauge as the first `gauge` frame (FEN-184). The
   * `welcome` frame implies "ready" but carries no charge count, and a gauge frame
   * is otherwise emitted only after a placement (`ack`) or a tier claim — so a
   * fresh authenticated session can never make that first placement: the client
   * gates the canvas on a known gauge (`placeState.ts`: `gauge === null` ⇒ the
   * indefinite "loading"/"La fresque arrive…" state) and refuses the tap, which
   * deadlocks placement. A read-only `refill-peek` (no consume, no persist) gives
   * the live charges/cooldown to render immediately.
   *
   * Anonymous viewers (`userId === null`) never place, so they need no gauge. The
   * effective max may still be at the base if the per-session F6 bonus refresh has
   * not resolved yet; that only understates a bonus until the next gauge frame
   * (place ack / tier claim) re-states it — it never blocks placement. Best-effort:
   * a peek failure is logged and skipped, never fatal to the connection.
   */
  private async sendInitialGauge(conn: Connection): Promise<void> {
    if (conn.user.userId === null) return;
    try {
      const gaugeParams: GaugeParams = { ...this.cfg.gauge.base, gaugeMax: conn.gauge.effectiveGaugeMax };
      const snap = await this.gaugePeek.peek(conn.user.userId, gaugeParams, Date.now());
      conn.sendJson({
        t: "gauge",
        charges: snap.charges,
        max: snap.max,
        cooldownUntil: snap.cooldownUntil,
      });
    } catch (err) {
      console.warn(`[gateway] initial gauge send failed for ${conn.user.userId}: ${(err as Error).message}`);
    }
  }

  private async onClientMessage(conn: Connection, raw: string): Promise<void> {
    // G-I2: bound the raw inbound message rate per socket BEFORE any parse /
    // validation / Redis work, so a flood can't burn CPU or hot-path round-trips.
    // The gauge limits accepted placements; this limits messages of any kind.
    if (conn.limiter && !conn.limiter.tryRemove(Date.now())) {
      conn.sendJson({ t: "error", code: "rate_limited", message: "slow down" });
      return;
    }
    let msg: ClientMessage;
    try {
      msg = decodeJson<ClientMessage>(raw);
    } catch {
      conn.sendJson({ t: "error", code: "internal", message: "malformed message" });
      return;
    }
    switch (msg.t) {
      case "ping":
        conn.sendJson({ t: "pong" });
        return;
      case "resync":
        await this.handleResync(conn, msg.seq);
        return;
      case "place":
        // Read-only enforcement (CA5): an anonymous visitor (no JWT at upgrade)
        // may watch the canvas but never write. Reject before the placement path.
        if (conn.user.userId === null) {
          conn.sendJson({
            t: "error",
            code: "unauthenticated",
            message: "sign in to place pixels",
            cid: msg.cid,
          });
          return;
        }
        await this.placement.handlePlace(conn, msg);
        return;
      default:
        conn.sendJson({ t: "error", code: "internal", message: "unknown message type" });
    }
  }

  /** Incremental replay if possible (CA2), else resyncRequired + fresh snapshot. */
  private async handleResync(conn: Connection, clientSeq: number): Promise<void> {
    const missed = this.ring.since(clientSeq);
    if (missed !== null) {
      if (missed.length === 0) return; // already current
      const writes: PixelWrite[] = missed.map((d) => ({ x: d.x, y: d.y, color: d.color }));
      const seq = missed[missed.length - 1]!.seq;
      conn.sendBinary(Buffer.from(encodeDelta(seq, writes)));
      return;
    }
    // Too far behind (or landed on a fresh instance): full snapshot.
    conn.sendJson({ t: "resyncRequired" });
    try {
      const snap = await readCanvasSnapshot(this.redis.cmd, this.cfg.canvasId ?? DEFAULT_CANVAS_ID, this.cfg.width, this.cfg.height);
      conn.sendBinary(Buffer.from(encodeSnapshot(snap.pixels, snap.seq, this.cfg.width, this.cfg.height)));
    } catch (err) {
      conn.sendJson({ t: "error", code: "internal", message: "resync snapshot failed" });
      console.warn(`[gateway] resync snapshot failed: ${(err as Error).message}`);
    }
  }
}

/** Pull the JWT from the upgrade request: `?token=`, then `Authorization: Bearer`. */
function extractToken(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return undefined;
}
