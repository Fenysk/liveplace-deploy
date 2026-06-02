/**
 * @canvas/protocol — the single source of truth for the wire contract between
 * the web/OBS clients, the WS gateway, and the Redis hot path.
 *
 * Frozen in Phase 1 to unblock the Backend, Full-stack and Frontend hires.
 * Breaking changes must bump PROTOCOL_VERSION and be recorded in an ADR.
 */

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Canvas geometry & palette (PROVISIONAL contract)
//
// Dimensions and palette are intentionally small for the MVP. The cooldown/gauge
// *defaults* are decision D1 (owned by the Product Owner) and live server-side,
// NOT here. Geometry below is a provisional contract: tunable until D1 lands,
// after which it is frozen. Clients MUST read width/height from the snapshot
// frame rather than hard-coding these, so a later change is non-breaking.
// ─────────────────────────────────────────────────────────────────────────────

export const CANVAS_WIDTH = 512;
export const CANVAS_HEIGHT = 512;

/**
 * Fixed 32-colour palette. A pixel is stored as a 1-byte index into this table
 * (palette-indexed binary — see ADR-0002 / D2). Index 0 is the default/empty
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
  | { t: "place"; x: number; y: number; color: number; seq?: number }
  | { t: "ping" }
  /**
   * Reconnect resync request. `seq` is the highest delta sequence the client
   * has already applied (0 if none). The gateway replays writes with seq >
   * this value when they are still buffered, otherwise it answers with
   * `resyncRequired` followed by a fresh snapshot. See contracts/ws-protocol.md.
   */
  | { t: "resync"; seq: number };

/** Reasons the server may reject a placement or connection. */
export type ErrorCode =
  | "unauthenticated"
  | "cooldown"
  | "out_of_bounds"
  | "invalid_color"
  | "rate_limited"
  | "banned"
  | "internal";

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
  | ({ t: "ack"; seq: number } & GaugeState)
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
  | { t: "error"; code: ErrorCode; message: string; seq?: number }
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
// per pixel. See ADR-0002 (D2). The per-frame seq was added for F7 (FEN-13)
// before any client consumed the format; PROTOCOL_VERSION stays 1.
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
