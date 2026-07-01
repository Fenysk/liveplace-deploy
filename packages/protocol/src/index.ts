/**
 * @canvas/protocol — the single source of truth for the wire contract between
 * the web/OBS clients, the WS gateway, and the Redis hot path.
 *
 * Frozen in Phase 1 to unblock the Backend, Full-stack and Frontend hires.
 * Breaking changes must bump PROTOCOL_VERSION and be recorded in an ADR.
 *
 * v2 (ADR-0006, FEN-564): ErrorCode unified with PlaceStatus — added `frozen`
 * (moderation freeze, previously aliased as `rate_limited`) and `bad_request`
 * (client-side protocol error: malformed JSON or unknown message type).
 */

export const PROTOCOL_VERSION = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Canvas geometry & palette (PROVISIONAL contract)
//
// Dimensions and palette are intentionally small for the MVP. The cooldown/gauge
// *defaults* are decision D1 (owned by the Product Owner) and live server-side,
// NOT here. Geometry below is a provisional contract: tunable until D1 lands,
// after which it is frozen. Clients MUST read width/height from the snapshot
// frame rather than hard-coding these, so a later change is non-breaking.
// ─────────────────────────────────────────────────────────────────────────────

// 512 is also the F2 public-create ceiling (`canvasRules.MAX_DIMENSION`,
// ADR-0004), so the deployed default geometry is a valid `createCanvas` value
// and the authenticated path can never be capped below the hot path. The binary
// frames encode width/height/x/y as u16, so 512 is well within range.
export const CANVAS_WIDTH = 512;
export const CANVAS_HEIGHT = 512;

/**
 * Fixed 32-colour palette. A pixel is stored as a 1-byte index into this table
 * (palette-indexed binary — see ADR-0006 / D2). Index 0 is the default/empty
 * colour. RGBA, 8-bit channels.
 */
export const PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [255, 255, 255, 255], // 0  white (default)
  [228, 228, 228, 255], // 1  light grey
  [136, 136, 136, 255], // 2  grey
  [ 34,  34,  34, 255], // 3  near-black
  [255, 167, 209, 255], // 4  pink
  [229,   0,   0, 255], // 5  red
  [229, 137,   0, 255], // 6  orange
  [160, 106,  66, 255], // 7  brown
  [229, 217,   0, 255], // 8  yellow
  [148, 224,  68, 255], // 9  light green
  [  2, 190,   1, 255], // 10 green
  [  0, 211, 221, 255], // 11 cyan
  [  0, 131, 199, 255], // 12 blue
  [  0,   0, 234, 255], // 13 dark blue
  [207, 110, 228, 255], // 14 light purple
  [130,   0, 128, 255], // 15 purple
  [  0,   0,   0, 255], // 16 black
  [ 17,  17,  17, 255], // 17
  [ 76,  76,  76, 255], // 18
  [255, 255, 128, 255], // 19
  [ 50, 102,  20, 255], // 20
  [255,   0, 255, 255], // 21 magenta
  [ 96,  64,  32, 255], // 22
  [255, 128,   0, 255], // 23
  [128, 255, 255, 255], // 24
  [128, 128, 255, 255], // 25
  [ 64,   0,   0, 255], // 26
  [  0,  64,   0, 255], // 27
  [  0,   0,  64, 255], // 28
  [192, 192, 192, 255], // 29
  [255, 215,   0, 255], // 30 gold
  [173, 216, 230, 255], // 31 light blue
] as const;

export const PALETTE_SIZE = PALETTE.length;

export function isValidColorIndex(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c < PALETTE_SIZE;
}

export function isInBounds(x: number, y: number, width = CANVAS_WIDTH, height = CANVAS_HEIGHT): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-frame (JSON) control protocol
// ─────────────────────────────────────────────────────────────────────────────

/** Client → Server messages (sent as JSON text frames). */
export type ClientMessage =
  /**
   * Request a placement; gauge-gated. `cid` is the OPAQUE client-generated op id
   * (a UUID or `${sessionId}:${n}`), echoed back in `ack`/`error` so an optimistic
   * client can reconcile (commit/rollback) its pending pixel. It is ALSO the CA5
   * idempotency key: a resend of the same `cid` places exactly once (no 2nd gauge
   * consume / fan-out). Ratified by the WS-protocol owner (FEN-63, contract
   * `1aa494a`) in place of the former server-authoritative `seq` — a client can't
   * learn `seq` before its ack, and a restart-resettable counter could false-replay.
   * Additive & optional: a naive client that omits `cid` gets no dedup/echo.
   *
   * `seq` is the DEPRECATED transitional op id (the pre-FEN-63 optimistic client
   * tagged placements with a client-local integer). The gateway no longer keys
   * idempotency on it — `cid` does — but still echoes it on `ack`/`error` so a
   * not-yet-migrated client keeps reconciling. Removed once the web client moves
   * to `cid` (FEN-60).
   */
  | { t: "place"; x: number; y: number; color: number; cid?: string; seq?: number }
  | { t: "ping" }
  /**
   * Reconnect resync request. `seq` is the highest delta sequence the client
   * has already applied (0 if none). The gateway replays writes with seq >
   * this value when they are still buffered, otherwise it answers with
   * `resyncRequired` followed by a fresh snapshot. See contracts/ws-protocol.md.
   */
  | { t: "resync"; seq: number }
  /**
   * Client requests the gateway to re-evaluate and push its current gauge as a
   * `{ t: "gauge" }` frame. Emitted when the client's local refill countdown
   * reaches zero, on tab focus/visibility restore, or as a self-healing
   * mechanism for a missed passive-refill push. No payload. ADDITIVE &
   * non-breaking (a gateway that does not know this message type ignores it):
   * additive, so it does not bump PROTOCOL_VERSION.
   */
  | { t: "gaugePeek" };

/** Reasons the server may reject a placement or connection. */
export type ErrorCode =
  | "unauthenticated"
  | "cooldown"
  | "out_of_bounds"
  | "invalid_color"
  | "rate_limited"
  | "banned"
  | "internal"
  /** Canvas frozen by moderation (F8.4) — distinct from `rate_limited` (gauge empty). */
  | "frozen"
  /** Client sent malformed JSON or an unknown message type. */
  | "bad_request";

/**
 * The viewer's pixel gauge (token bucket) for display — decision D1. Sent on
 * every placement ack and whenever the gateway pushes a refresh, so the web UI
 * and OBS overlay can render current/max and a countdown to the next charge.
 * The numeric mechanics live server-side (@canvas/redis-scripts gauge).
 */
export interface GaugeState {
  /** Charges available right now (post lazy-refill). */
  charges: number;
  /** Effective maximum = gaugeMaxBase + per-user upgrade bonus. */
  max: number;
  /** Epoch ms the next charge lands; 0 when the gauge is full. */
  cooldownUntil: number;
}

/** Server → Client messages (sent as JSON text frames). */
export type ServerMessage =
  | {
      t: "welcome";
      protocolVersion: number;
      width: number;
      height: number;
      /** epoch ms until which the authenticated user is on cooldown (0 = ready) */
      cooldownUntil: number;
      /**
       * Highest delta sequence reflected by the snapshot the client is about to
       * receive. The client tracks this and sends it back in a `resync` after a
       * reconnect so the gateway can compute what it missed.
       */
      seq: number;
    }
  /**
   * Sender's own placement accepted, with the post-consume gauge. `cid` echoes
   * the `place` op id (FEN-63) so an optimistic client commits the right pending
   * pixel — it is the ratified correlation. `seq` is the DEPRECATED transitional
   * echo of the client's pre-FEN-63 integer op id, kept so a not-yet-migrated
   * client (FEN-60) still reconciles; 0 when the client sent none.
   */
  | ({ t: "ack"; seq: number; cid?: string } & GaugeState)
  | { t: "cooldown"; until: number }
  /**
   * Unsolicited gauge refresh (e.g. after a passive refill tick or an upgrade
   * that raised the ceiling). Lets the client update current/max/countdown
   * without placing. Carries the same {charges, max, cooldownUntil} as an ack.
   */
  | ({ t: "gauge" } & GaugeState)
  /** Current number of connected viewers across all gateway instances (presence). */
  | { t: "viewerCount"; count: number }
  /**
   * The gateway cannot serve an incremental resync (the requested seq has aged
   * out of the buffer, or it landed on a fresh instance). A full snapshot frame
   * follows immediately; the client should replace its canvas, not reload the page.
   */
  | { t: "resyncRequired" }
  /**
   * A server-initiated bulk overwrite just changed the fresco for everyone — a
   * moderation **wipe / ban-and-wipe** (the cells also arrive as ordinary deltas;
   * this frame is the *attribution* the deltas lack). It exists so a watching
   * client can tell "a moderation event happened here" apart from a reconnect
   * `resyncRequired` (a NETWORK event), which would otherwise be the only signal a
   * mass change occurred and reads as anxiety, not explanation (UX Lot I / FEN-121).
   * `version` is the last write seq of the action (monotonic per canvas); `cells`
   * is how many pixels it touched — both informational. A freeze/unfreeze is NOT
   * announced here: it is already observable via `canPlace`→`placement_closed`.
   *
   * ADDITIVE & non-breaking: a client that does not know `t === "moderationEvent"`
   * ignores it (same as any unknown frame) and still applies the deltas, so it
   * does not bump PROTOCOL_VERSION — same evolution rule as the F7 per-frame seq,
   * which was added before any client consumed it. Server → client only.
   */
  | { t: "moderationEvent"; version: number; cells: number }
  /**
   * A rejected placement (→ client rollback) or a transport-level error. `cid`
   * echoes the rejected `place` op id (FEN-63) when the error pertains to a
   * placement, so an optimistic client can roll back exactly the pending pixel it
   * tagged; omitted for errors not tied to a `place` (e.g. malformed frame). `seq`
   * is the DEPRECATED transitional echo for the pre-FEN-60 client (see `place`).
   */
  | { t: "error"; code: ErrorCode; message: string; cid?: string; seq?: number }
  | { t: "pong" };

export function encodeJson(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeJson<T = ClientMessage | ServerMessage>(data: string): T {
  return JSON.parse(data) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary-frame protocol (ArrayBuffer)
//
// All binary frames begin with a 1-byte opcode followed by a u32 sequence
// number. Multi-byte integers are big-endian (network order).
//
// The `seq` carried by every frame is the gateway's global, monotonically
// increasing write counter (Redis canvas:writes:count). It is what makes
// reconnect-resync possible: a client remembers the seq of the last frame it
// applied, and on reconnect asks the gateway to replay everything after it
// (see ClientMessage `resync`). Because a live WebSocket delivers frames in
// order over TCP, the client can only ever miss frames across a disconnect —
// never mid-stream — so a single per-frame seq is sufficient to detect and
// repair gaps.
//
//   SNAPSHOT (0x01): full canvas, palette-indexed, 1 byte/pixel, row-major.
//     [u8 op=0x01][u32 seq][u16 width][u16 height][u8 pixels[width*height]]
//
//   DELTA (0x02): a coalesced batch of pixel writes. `seq` is the highest
//     write sequence included in this batch (last-write-wins per pixel).
//     [u8 op=0x02][u32 seq][u16 count][ {u16 x, u16 y, u8 color} * count ]
//
// Rationale for binary + palette indices: the canvas IS a byte string in Redis,
// so the snapshot is a single GET with zero transcoding, and a delta is 5 bytes
// per pixel. See ADR-0006 (D2). The per-frame seq was added for F7 (FEN-13)
// before any client consumed the format, so it did not bump PROTOCOL_VERSION
// (now 2 — see the v2 note in the file header).
// ─────────────────────────────────────────────────────────────────────────────

export const OP_SNAPSHOT = 0x01;
export const OP_DELTA = 0x02;

export const DELTA_RECORD_BYTES = 5; // u16 x + u16 y + u8 color
export const SNAPSHOT_HEADER_BYTES = 9; // u8 op + u32 seq + u16 width + u16 height
export const DELTA_HEADER_BYTES = 7; // u8 op + u32 seq + u16 count

export interface PixelWrite {
  x: number;
  y: number;
  color: number;
}

export function encodeSnapshot(
  pixels: Uint8Array,
  seq: number,
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
): ArrayBuffer {
  if (pixels.length !== width * height) {
    throw new Error(`snapshot size mismatch: got ${pixels.length}, expected ${width * height}`);
  }
  const buf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + pixels.length);
  const view = new DataView(buf);
  view.setUint8(0, OP_SNAPSHOT);
  view.setUint32(1, seq >>> 0);
  view.setUint16(5, width);
  view.setUint16(7, height);
  new Uint8Array(buf, SNAPSHOT_HEADER_BYTES).set(pixels);
  return buf;
}

export interface DecodedSnapshot {
  seq: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function decodeSnapshot(buf: ArrayBuffer): DecodedSnapshot {
  const view = new DataView(buf);
  if (view.getUint8(0) !== OP_SNAPSHOT) throw new Error("not a snapshot frame");
  const seq = view.getUint32(1);
  const width = view.getUint16(5);
  const height = view.getUint16(7);
  const pixels = new Uint8Array(buf.slice(SNAPSHOT_HEADER_BYTES, SNAPSHOT_HEADER_BYTES + width * height));
  return { seq, width, height, pixels };
}

export function encodeDelta(seq: number, writes: ReadonlyArray<PixelWrite>): ArrayBuffer {
  const buf = new ArrayBuffer(DELTA_HEADER_BYTES + writes.length * DELTA_RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, OP_DELTA);
  view.setUint32(1, seq >>> 0);
  view.setUint16(5, writes.length);
  let off = DELTA_HEADER_BYTES;
  for (const w of writes) {
    view.setUint16(off, w.x);
    view.setUint16(off + 2, w.y);
    view.setUint8(off + 4, w.color);
    off += DELTA_RECORD_BYTES;
  }
  return buf;
}

export interface DecodedDelta {
  seq: number;
  writes: PixelWrite[];
}

export function decodeDelta(buf: ArrayBuffer): DecodedDelta {
  const view = new DataView(buf);
  if (view.getUint8(0) !== OP_DELTA) throw new Error("not a delta frame");
  const seq = view.getUint32(1);
  const count = view.getUint16(5);
  const writes: PixelWrite[] = [];
  let off = DELTA_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    writes.push({
      x: view.getUint16(off),
      y: view.getUint16(off + 2),
      color: view.getUint8(off + 4),
    });
    off += DELTA_RECORD_BYTES;
  }
  return { seq, writes };
}

/** Peek the opcode of an incoming binary frame to route it. */
export function binaryOpcode(buf: ArrayBuffer): number {
  return new DataView(buf).getUint8(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering helper shared by web canvas + OBS view: palette index → RGBA.
// ─────────────────────────────────────────────────────────────────────────────

/** Expand a palette-indexed canvas into an RGBA buffer suitable for ImageData. */
export function paletteToRGBA(pixels: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i] ?? 0;
    const c = PALETTE[idx] ?? PALETTE[0]!;
    const o = i * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = c[3];
  }
  return rgba;
}
