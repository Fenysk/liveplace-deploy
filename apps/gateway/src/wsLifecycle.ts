/**
 * WebSocket upgrade and per-connection lifecycle for the gateway (G1 — FEN-1947).
 *
 * Handles:
 *   - HTTP→WS upgrade (auth ticket, ?canvas= extraction, 400/401 rejection)
 *   - onConnection: connection tracking, gauge bootstrap, socket event wiring
 *   - Initial state delivery (welcome, snapshot, viewer count, gauge)
 *   - Per-message dispatch (ping, gaugePeek, resync, place)
 *   - Incremental resync (CA2) with snapshot fallback
 */
import { type IncomingMessage, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeJson,
  encodeDelta,
  encodeSnapshot,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PixelWrite,
} from "@canvas/protocol";
import { type GaugeParams } from "@canvas/redis-scripts";
import type { GatewayConfig } from "./config";
import { AuthError, type AuthedUser, type SocketAuthenticator } from "./auth";
import {
  SessionGauge,
  type GaugeBonusSource,
  type GaugePeekRunner,
} from "./gaugeBonus";
import { TokenBucket } from "./rateLimiter";
import { readCanvasSnapshot, type RedisPair } from "./redis";
import { gaugeFrame } from "./frames";
import { AttributionStore, readRefCookie } from "./attribution";
import { extractCanvasId, extractToken, CanvasIdError } from "./canvasId";
import type { CanvasState, PubSubManager } from "./pubsub";
import { Connection, type PlacementHandler } from "./connection";

export class WsLifecycleManager {
  constructor(
    private readonly cfg: GatewayConfig,
    private readonly auth: SocketAuthenticator,
    private readonly wss: WebSocketServer,
    private readonly clients: Set<Connection>,
    private readonly canvasStates: Map<string, CanvasState>,
    private readonly bonusSource: GaugeBonusSource,
    private readonly redis: RedisPair,
    private readonly gaugePeek: GaugePeekRunner,
    private readonly placement: PlacementHandler,
    private readonly pubsub: PubSubManager,
    private readonly attribution: AttributionStore,
  ) {}

  wireUpgrade(http: Server): void {
    http.on("upgrade", (req, socket, head) => {
      // R3 anti-injection: parse ?canvas= before auth so an invalid id never
      // reaches any downstream logic. Valid absent → DEFAULT_CANVAS_ID.
      let canvasId: string;
      try {
        canvasId = extractCanvasId(req);
      } catch (err) {
        if (err instanceof CanvasIdError) {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\ninvalid ?canvas= parameter");
          socket.destroy();
          return;
        }
        throw err;
      }
      void this.authenticateUpgrade(req)
        .then((user) => {
          // FEN-242: attribute the signup if this authed visitor arrived via a
          // tracked DM link (the `/r`-set `lp_ref` cookie rides the upgrade).
          this.recordSignupAttribution(req, user);
          this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user, canvasId));
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

  private onConnection(ws: WebSocket, user: AuthedUser, canvasId: string): void {
    const gauge = new SessionGauge(this.bonusSource, user.userId, this.cfg.gauge.base.gaugeMax, canvasId);
    const limiter = new TokenBucket(
      this.cfg.socket.inboundBurst,
      this.cfg.socket.inboundRefillPerSec,
      Date.now(),
    );
    const conn = new Connection(ws, user, gauge, canvasId, limiter);
    this.clients.add(conn);

    // Lazily subscribe to the per-canvas delta channel on first connection.
    void this.pubsub.ensureCanvasSubscribed(canvasId);

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
      this.pubsub.reapCanvasIfEmpty(canvasId);
    });
    ws.on("error", () => {
      this.clients.delete(conn);
      this.pubsub.reapCanvasIfEmpty(canvasId);
    });

    // FEN-1762: resolve dims before sending the initial state so the welcome
    // frame and snapshot use the canvas's durable dimensions, not the global env.
    void this.pubsub.ensureCanvasSubscribed(canvasId).then(() => this.sendInitialState(conn));
  }

  /** welcome → snapshot → current viewer count. */
  private async sendInitialState(conn: Connection): Promise<void> {
    // FEN-1762: use the durable dims resolved at subscribe time; fall back to
    // env dims if canvasStates entry is missing (should not happen in practice).
    const dims = this.canvasStates.get(conn.canvasId)?.dims ?? { width: this.cfg.width, height: this.cfg.height };
    try {
      const snap = await readCanvasSnapshot(this.redis.cmd, conn.canvasId, dims.width, dims.height);
      conn.sendJson({
        t: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        width: dims.width,
        height: dims.height,
        cooldownUntil: 0, // gauge state is F4/F5; transport reports "ready".
        seq: snap.seq,
      });
      conn.sendBinary(Buffer.from(encodeSnapshot(snap.pixels, snap.seq, dims.width, dims.height)));
      if (this.pubsub.lastViewerCount >= 0) {
        conn.sendJson({ t: "viewerCount", count: this.pubsub.lastViewerCount });
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
    await this.sendGauge(conn);
  }

  /** Re-evaluate and push the connection's current gauge as a `{ t: "gauge" }` frame.
   *  No-op for anonymous connections (no gauge). Read-only peek — never consumes a charge.
   *  Used both at connect (sendInitialGauge) and on demand (`gaugePeek` client message). */
  private async sendGauge(conn: Connection): Promise<void> {
    if (conn.user.userId === null) return;
    try {
      const gaugeParams: GaugeParams = { ...this.cfg.gauge.base, gaugeMax: conn.gauge.effectiveGaugeMax };
      const snap = await this.gaugePeek.peek(conn.user.userId, conn.canvasId, gaugeParams, Date.now());
      conn.sendJson(gaugeFrame(snap));
    } catch (err) {
      console.warn(`[gateway] gauge send failed for ${conn.user.userId}: ${(err as Error).message}`);
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
      conn.sendJson({ t: "error", code: "bad_request", message: "malformed message" });
      return;
    }
    switch (msg.t) {
      case "ping":
        conn.sendJson({ t: "pong" });
        return;
      case "gaugePeek":
        // Client requests a fresh gauge push (e.g. local refill timer expired,
        // tab regained focus). Read-only peek; anonymous connections silently ignored.
        void this.sendGauge(conn);
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
        conn.sendJson({ t: "error", code: "bad_request", message: "unknown message type" });
    }
  }

  /** Incremental replay if possible (CA2), else resyncRequired + fresh snapshot. */
  private async handleResync(conn: Connection, clientSeq: number): Promise<void> {
    const state = this.canvasStates.get(conn.canvasId);
    const ring = state?.ring ?? null;
    const missed = ring?.since(clientSeq) ?? null;
    if (missed !== null) {
      if (missed.length === 0) return; // already current
      const writes: PixelWrite[] = missed.map((d) => ({ x: d.x, y: d.y, color: d.color }));
      const seq = missed[missed.length - 1]!.seq;
      conn.sendBinary(Buffer.from(encodeDelta(seq, writes)));
      return;
    }
    // Too far behind (or landed on a fresh instance): full snapshot.
    conn.sendJson({ t: "resyncRequired" });
    // FEN-1762: use per-canvas dims so the snapshot is the right size.
    const dims = state?.dims ?? { width: this.cfg.width, height: this.cfg.height };
    try {
      const snap = await readCanvasSnapshot(this.redis.cmd, conn.canvasId, dims.width, dims.height);
      conn.sendBinary(Buffer.from(encodeSnapshot(snap.pixels, snap.seq, dims.width, dims.height)));
    } catch (err) {
      conn.sendJson({ t: "error", code: "internal", message: "resync snapshot failed" });
      console.warn(`[gateway] resync snapshot failed: ${(err as Error).message}`);
    }
  }

  /**
   * Outreach funnel SIGNUP (FEN-242). Called on every authenticated WS upgrade:
   * if the browser replays an `lp_ref` cookie (set by `/r`), attribute the user
   * to that ref. First ref wins, deduped per user (see AttributionStore). Anon
   * sockets (no JWT) carry no signup. Best-effort and off the placement path.
   */
  private recordSignupAttribution(req: IncomingMessage, user: AuthedUser): void {
    if (user.userId === null) return;
    const ref = readRefCookie(req.headers.cookie);
    if (!ref) return;
    void this.attribution
      .recordSignup(user.userId, ref)
      .catch((err) => console.warn(`[gateway] attribution signup failed: ${(err as Error).message}`));
  }
}
