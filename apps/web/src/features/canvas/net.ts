/**
 * Canonical canvas WS client (FEN-65) over the FROZEN `@canvas/protocol`.
 *
 * Responsibilities (the transport half; the optimism/rollback half is
 * {@link OptimisticPlacement} in `placement.ts`):
 *   - open the gateway socket (optional Convex JWT, anonymous read-only
 *     fallback), `binaryType = "arraybuffer"`;
 *   - route incoming frames: binary `snapshot`(0x01)/`delta`(0x02) → the renderer,
 *     text `ack`/`error`/`cooldown`/`gauge` → the placement controller,
 *     `welcome`/`viewerCount`/`resyncRequired`/`pong` → handled here;
 *   - track the highest applied write `seq` (from `welcome` and each binary
 *     frame) so a reconnect can ask the gateway to replay the gap via
 *     `resync { seq }` (contract §resync). When the gateway can't, it answers
 *     `resyncRequired` + a fresh snapshot; the renderer replaces the buffer and
 *     the caller calls `placement.repaintPending()`.
 *   - on reconnect, fire `onReconnected` so the caller re-sends un-acked ops with
 *     their ORIGINAL `cid` (CA5 exactly-once via the gateway's `SET NX`).
 *
 * It does NOT redefine the wire contract — only consumes it. The auth token is
 * a transport detail (a `?token=` query param carrying the Convex JWT the gateway
 * verifies offline against Convex JWKS — see apps/gateway/src/{auth,gateway}.ts
 * `extractToken`), not a protocol frame: the pre-FEN-63 `hello` handshake is gone;
 * the gateway pushes `welcome` on connect. A tokenless connect is admitted as an
 * anonymous read-only viewer (FEN-184).
 */
import {
  binaryOpcode,
  OP_DELTA,
  OP_SNAPSHOT,
  decodeJson,
  type ClientMessage,
  type ServerMessage,
} from "@canvas/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** The `welcome` frame, narrowed from the protocol union. */
export type Welcome = Extract<ServerMessage, { t: "welcome" }>;

/** The minimal `WebSocket` surface we use — lets tests inject a fake socket. */
export interface MinimalSocket {
  binaryType: string;
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  readonly readyState: number;
}

export interface CanvasNetHandlers {
  /** Handshake: carries board geometry + the snapshot's baseline write seq. */
  onWelcome?: (w: Welcome) => void;
  /**
   * A binary frame (snapshot/delta). Return the highest write `seq` now applied
   * so the client can advance its resync cursor; return void/undefined to leave
   * the cursor unchanged (e.g. a stale/ignored frame).
   */
  onBinary?: (buf: ArrayBuffer) => number | void;
  /** A placement-related text frame: `ack` / `error` / `cooldown` / `gauge`. */
  onPlacementFrame?: (msg: ServerMessage) => void;
  /** Presence count refresh. */
  onViewerCount?: (count: number) => void;
  /** The gateway will replace the canvas with a fresh snapshot (resync failed). */
  onResyncRequired?: () => void;
  /**
   * A server-initiated bulk overwrite (moderation wipe / ban-and-wipe) just
   * changed the fresco for everyone — the `moderationEvent` attribution frame the
   * raw deltas lack (FEN-156 / contract §"Viewer fan-out side-effect"). The net
   * layer keeps a monotonic `bulkChangeSeq` and bumps it ONCE per such frame, then
   * fires this with the bumped counter plus the frame's informational
   * `version`/`cells`. Crucially it is NOT bumped for the client's own reconnect
   * `resyncRequired` (a NETWORK event) — that path never reaches here — so a blip
   * never reads as moderation. {@link CanvasView} feeds the counter into
   * `deriveModerationNotice` and `areaChanged` lights up (UX Lot I / FEN-121).
   */
  onModerationEvent?: (ev: { bulkChangeSeq: number; version: number; cells: number }) => void;
  /** Connection lifecycle, for the "connecting…/offline" UI. */
  onStatus?: (status: ConnectionStatus) => void;
  /** Fired after a RE-connect's welcome: re-send the un-acked resend queue. */
  onReconnected?: () => void;
}

export interface CanvasNetOptions {
  /** WS endpoint, e.g. `wss://host/canvas/{slug}/ws`. */
  url: string;
  handlers: CanvasNetHandlers;
  /**
   * Resolve the Convex JWT for this connection, appended as `?token=` (the param
   * the gateway's `extractToken` reads). Return `null` for an anonymous read-only
   * connection. Defaults to anonymous: the SPA-direct architecture has no
   * `/api/ws-ticket` host, so the app injects a provider that reads the live
   * Convex JWT (`authClient.convex.token()`), gated on `useConvexAuth()` — see
   * CanvasView (FEN-184).
   */
  fetchTicket?: () => Promise<string | null>;
  /** Injectable socket constructor for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => MinimalSocket;
  /** Reconnect backoff (ms); defaults to 1500. */
  reconnectDelayMs?: number;
  /** Injectable timer for tests; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const OPEN = 1; // WebSocket.OPEN

/**
 * Default token resolver: anonymous read-only. There is no `/api/ws-ticket` host
 * in the SPA-direct Convex Better Auth architecture (FEN-184); the app supplies a
 * provider that returns the live Convex JWT instead (see CanvasView). Connecting
 * without a token is a valid anonymous viewer, so the fallback is `null`, never a
 * doomed fetch to a non-existent endpoint.
 */
async function defaultFetchTicket(): Promise<string | null> {
  return null;
}

export class CanvasNetClient {
  private socket: MinimalSocket | null = null;
  private readonly handlers: CanvasNetHandlers;
  private readonly fetchTicket: () => Promise<string | null>;
  private readonly socketFactory: (url: string) => MinimalSocket;
  private readonly reconnectDelayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  private appliedSeq = 0; // highest write seq applied (resync cursor)
  private bulkChangeSeq = 0; // monotonic count of server-initiated bulk overwrites (moderation)
  private gotWelcome = false; // distinguishes first connect from a reconnect
  private everConnected = false;
  private stopped = false;

  constructor(private readonly opts: CanvasNetOptions) {
    this.handlers = opts.handlers;
    this.fetchTicket = opts.fetchTicket ?? defaultFetchTicket;
    this.socketFactory =
      opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as MinimalSocket);
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1500;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Open (or re-open) the gateway connection. */
  async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onStatus?.("connecting");
    const ticket = await this.fetchTicket();
    if (this.stopped) return;

    const url = ticket
      ? `${this.opts.url}${this.opts.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(ticket)}`
      : this.opts.url;

    const socket = this.socketFactory(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.gotWelcome = false;

    socket.onopen = () => {
      this.handlers.onStatus?.("open");
      // A live reconnect asks the gateway to replay what we missed; the first
      // connection just waits for the unsolicited welcome + snapshot.
      if (this.everConnected) this.sendRaw({ t: "resync", seq: this.appliedSeq });
    };
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onclose = () => this.onClose();
    socket.onerror = () => {
      // surfaced via the close that follows; nothing to do here.
    };
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.onBinary(data as ArrayBuffer);
      return;
    }
    const msg = decodeJson<ServerMessage>(data);
    switch (msg.t) {
      case "welcome":
        this.onWelcome(msg);
        break;
      case "ack":
      case "error":
      case "cooldown":
      case "gauge":
        this.handlers.onPlacementFrame?.(msg);
        break;
      case "viewerCount":
        this.handlers.onViewerCount?.(msg.count);
        break;
      case "resyncRequired":
        // A full snapshot frame follows; the renderer replaces the buffer and
        // the caller repaints its pending optimistic pixels onto the new base.
        this.handlers.onResyncRequired?.();
        break;
      case "moderationEvent":
        // A moderation bulk overwrite (wipe / ban-and-wipe). Distinct from the
        // reconnect `resyncRequired` above (a network event), this is the
        // *attribution* the deltas lack: bump the monotonic counter once and hand
        // it to the viewer-legibility reducer so `areaChanged` can light up.
        this.bulkChangeSeq += 1;
        this.handlers.onModerationEvent?.({
          bulkChangeSeq: this.bulkChangeSeq,
          version: msg.version,
          cells: msg.cells,
        });
        break;
      case "pong":
        break;
    }
  }

  private onWelcome(w: Welcome): void {
    this.appliedSeq = w.seq;
    const reconnected = this.everConnected;
    this.everConnected = true;
    this.gotWelcome = true;
    this.handlers.onWelcome?.(w);
    if (reconnected) this.handlers.onReconnected?.();
  }

  private onBinary(buf: ArrayBuffer): void {
    const op = binaryOpcode(buf);
    if (op !== OP_SNAPSHOT && op !== OP_DELTA) return;
    const applied = this.handlers.onBinary?.(buf);
    if (typeof applied === "number" && applied >= 0) this.appliedSeq = applied;
  }

  private onClose(): void {
    this.socket = null;
    this.handlers.onStatus?.("closed");
    if (this.stopped) return;
    this.setTimer(() => void this.connect(), this.reconnectDelayMs);
  }

  /**
   * Force an immediate reconnect, re-running {@link fetchTicket}. Used when the
   * auth state changes (FEN-184): the post-OAuth landing connects anonymously
   * ~1s before the Convex JWT is available, and sign-out must drop back to the
   * anonymous read-only socket. Closing the current socket without re-running the
   * backoff (we reconnect now, not after `reconnectDelayMs`) keeps the swap quick;
   * the gateway re-sends `welcome` on the new connection, so geometry/state heal.
   * A no-op once {@link disconnect} has stopped the client.
   */
  reconnect(): void {
    if (this.stopped) return;
    const stale = this.socket;
    this.socket = null;
    if (stale) {
      // Detach the close handler so its scheduled-backoff reconnect can't race
      // the immediate one we fire here (which carries the fresh token).
      stale.onclose = null;
      stale.close();
    }
    void this.connect();
  }

  /** Send a `place` op (from {@link OptimisticPlacement.place}). */
  place(msg: ClientMessage): void {
    this.sendRaw(msg);
  }

  private sendRaw(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Highest write seq applied (resync cursor) — exposed for tests/diagnostics. */
  get cursor(): number {
    return this.appliedSeq;
  }

  /** Monotonic count of moderation bulk overwrites observed — for tests/diagnostics. */
  get bulkCursor(): number {
    return this.bulkChangeSeq;
  }

  /** True once the current connection's `welcome` has landed. */
  get ready(): boolean {
    return this.gotWelcome;
  }

  /** Stop reconnecting and close the socket. */
  disconnect(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }
}
