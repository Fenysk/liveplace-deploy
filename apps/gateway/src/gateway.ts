/**
 * The WebSocket gateway — slim assembler (G1/FEN-1947).
 *
 * Delegates to specialised modules:
 *   internalRoutes.ts — /internal/* + /r attribution HTTP seam
 *   pubsub.ts         — Redis delta subscriptions, flush, presence, heartbeat
 *   wsLifecycle.ts    — HTTP→WS upgrade, per-connection lifecycle, message dispatch
 *   connection.ts     — Connection class + PlacementHandler interface
 *   canvasId.ts       — extractCanvasId, parseCanvasDeltaChannel, extractToken
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { canvasDeltaChannel } from "@canvas/redis-scripts";
import type { GatewayConfig } from "./config";
import { createAuthenticator } from "./auth";
import { StaticGaugeBonusSource, IoredisGaugePeekRunner, type GaugeBonusSource } from "./gaugeBonus";
import { AttributionStore } from "./attribution";
import { createRedisPair, clearPresence, type RedisPair } from "./redis";
import { CanvasDimsCache } from "./canvasDims";
import { Connection, type PlacementHandler } from "./connection";
import type { CanvasState } from "./pubsub";
import { PubSubManager } from "./pubsub";
import { WsLifecycleManager } from "./wsLifecycle";
import { InternalRoutesHandler } from "./internalRoutes";

export type { PlacementHandler };
export { Connection, canvasDeltaChannel };

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
  private readonly clients = new Set<Connection>();
  private readonly canvasStates = new Map<string, CanvasState>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly pubsub: PubSubManager;
  private readonly internalRoutes: InternalRoutesHandler;

  private flushTimer?: ReturnType<typeof setInterval>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly cfg: GatewayConfig,
    placement: PlacementHandler = rejectingPlacementHandler,
    redis?: RedisPair,
    bonusSource: GaugeBonusSource = new StaticGaugeBonusSource(0),
    dimsCache?: CanvasDimsCache,
  ) {
    this.redis = redis ?? createRedisPair(cfg.redisUrl);
    const resolvedDimsCache = dimsCache ?? new CanvasDimsCache(null, { width: cfg.width, height: cfg.height });

    this.pubsub = new PubSubManager(
      this.redis,
      cfg,
      this.clients,
      this.canvasStates,
      resolvedDimsCache,
    );

    this.internalRoutes = new InternalRoutesHandler(
      cfg,
      resolvedDimsCache,
      this.redis,
      this.clients,
      this.canvasStates,
    );

    const auth = createAuthenticator(cfg.auth);
    this.wss = new WebSocketServer({ noServer: true });
    this.http = createServer((req, res) => {
      void this.internalRoutes.handleHttp(req, res);
    });

    const wsLifecycle = new WsLifecycleManager(
      cfg,
      auth,
      this.wss,
      this.clients,
      this.canvasStates,
      bonusSource,
      this.redis,
      new IoredisGaugePeekRunner(this.redis.cmd),
      placement,
      this.pubsub,
      new AttributionStore(this.redis.cmd),
    );
    wsLifecycle.wireUpgrade(this.http);
  }

  get boundPort(): number {
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : this.cfg.port;
  }

  async start(): Promise<void> {
    await this.pubsub.subscribeDeltas();
    this.flushTimer = setInterval(() => this.pubsub.flush(), this.cfg.flushIntervalMs);
    this.presenceTimer = setInterval(() => void this.pubsub.refreshPresence(), this.cfg.presenceRefreshMs);
    this.heartbeatTimer = setInterval(() => this.pubsub.heartbeat(), this.cfg.heartbeatMs);
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

}
