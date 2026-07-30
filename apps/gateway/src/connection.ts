/**
 * Per-socket connection state and the placement-handler interface (G1 — FEN-1947).
 *
 * Extracted from gateway.ts so that pubsub, wsLifecycle, and internalRoutes
 * can all import Connection without creating a circular dependency on gateway.ts.
 */
import { WebSocket } from "ws";
import { encodeJson, type ClientMessage, type ServerMessage } from "@canvas/protocol";
import type { AuthedUser } from "./auth";
import type { SessionGauge } from "./gaugeBonus";
import type { TokenBucket } from "./rateLimiter";

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
     * Canvas this connection reads from and writes to (plan FEN-1560, C1/S0).
     * Populated from the `?canvas=` WS upgrade query param by S1; until then
     * defaults to DEFAULT_CANVAS_ID so all existing single-canvas flows are
     * unaffected.
     */
    readonly canvasId: string,
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
