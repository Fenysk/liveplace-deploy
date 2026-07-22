/**
 * FEN-65 visual-capture harness — renders the F4 pose→ack→rollback flow to PNGs
 * WITHOUT a browser (none is available in CI here). It drives the REAL
 * {@link OptimisticPlacement} controller over the REAL pixel buffer
 * ({@link BufferSurface}, the same getPixel/setPixel contract the live
 * CanvasRenderer mutates) and expands palette indices to RGBA via the frozen
 * `@canvas/protocol` palette — so the captured images are exactly what the canvas
 * would draw at each stage, just rasterised in Node instead of on a <canvas>.
 *
 * Captures (written to apps/web/artifacts/):
 *   01-base.png            the snapshot baseline
 *   02-optimistic.png      a pose painted optimistically (pre-ack)
 *   03-ack-confirmed.png   the gateway ack — the pose is kept
 *   04-refused-optimistic.png  a pose over existing art (pre-verdict)
 *   05-cooldown-rollback.png   cooldown refusal — pose rolled back
 *   06-banned-rollback.png     banned (CA6) refusal — pose rolled back
 *
 * Run: node --experimental-transform-types scripts/visual-capture.ts
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, paletteToRGBA } from "@canvas/protocol";
import { OptimisticPlacement } from "../src/features/canvas/placement.ts";
import { BufferSurface } from "../src/features/canvas/bufferSurface.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "artifacts");
const W = 24;
const H = 24;
const CELL = 16; // device px per cell in the capture (nearest-neighbour upscale)

// ── minimal PNG encoder (RGBA, no deps beyond zlib) ──────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // filtered scanlines: filter byte 0 per row
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Upscale the palette-indexed board to an RGBA capture with a faint grid. */
function renderCapture(surface: BufferSurface): Buffer {
  const cells = paletteToRGBA(surface.pixels); // W*H * 4, native resolution
  const outW = W * CELL;
  const outH = H * CELL;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const cy = Math.floor(y / CELL);
    const onGridY = y % CELL === 0;
    for (let x = 0; x < outW; x++) {
      const cx = Math.floor(x / CELL);
      const si = (cy * W + cx) * 4;
      const di = (y * outW + x) * 4;
      const grid = onGridY || x % CELL === 0;
      // faint cell border for the r/place look
      const dim = grid ? 0.82 : 1;
      out[di] = Math.round(cells[si]! * dim);
      out[di + 1] = Math.round(cells[si + 1]! * dim);
      out[di + 2] = Math.round(cells[si + 2]! * dim);
      out[di + 3] = 255;
    }
  }
  return encodePng(out, outW, outH);
}

function save(name: string, surface: BufferSurface): void {
  writeFileSync(join(OUT, name), renderCapture(surface));
  console.log(`wrote ${name}  (pending=${pendingHint})`);
}

let pendingHint = 0;

// ── scenario ─────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const surface = new BufferSurface(W, H, 0);
// Seed a little existing "art" so a rollback visibly restores prior colours.
const seed: Array<[number, number, number]> = [
  [4, 4, 16], [5, 4, 16], [6, 4, 16], [4, 5, 16], [6, 5, 16], [4, 6, 16], [5, 6, 16], [6, 6, 16], // box (black)
  [12, 12, 8], [13, 12, 8], [12, 13, 8], [13, 13, 8], // yellow block
];
for (const [x, y, c] of seed) surface.setPixel(x, y, c);

// fixed clock + deterministic cids for reproducible captures
let cidN = 0;
const NOW = 1_000_000;
const feedback: string[] = [];
const placement = new OptimisticPlacement({
  width: W,
  height: H,
  paletteSize: PALETTE.length,
  surface,
  now: () => NOW,
  genCid: () => `cid-${++cidN}`,
  onFeedback: (f) => feedback.push(`${f.kind}:${f.messageKey}`),
});
// seed a non-empty gauge so local empty-block doesn't pre-reject the demo poses
placement.handle({ t: "gauge", charges: 3, max: 5, cooldownUntil: 0 });

pendingHint = placement.pendingCount;
save("01-base.png", surface);

// ── Capture A: optimistic pose → ack confirmed ───────────────────────────────
const heart: Array<[number, number]> = [
  [16, 5], [18, 5], [15, 6], [16, 6], [17, 6], [18, 6], [19, 6],
  [16, 7], [17, 7], [18, 7], [17, 8],
];
const aMsgs = heart.map(([x, y]) => placement.place(x, y, 5)); // red
pendingHint = placement.pendingCount;
save("02-optimistic.png", surface); // painted before any ack

for (const m of aMsgs) {
  if (m) placement.handle({ t: "ack", seq: 0, cid: m.cid!, charges: 2, max: 5, cooldownUntil: 0 });
}
pendingHint = placement.pendingCount;
save("03-ack-confirmed.png", surface); // pose kept, pending cleared

// ── Capture B: refused poses → rollback ──────────────────────────────────────
// Pose 1 over the yellow block (cooldown refusal), pose 2 over the black box (banned).
placement.handle({ t: "gauge", charges: 1, max: 5, cooldownUntil: 0 });
const overYellow = placement.place(12, 12, 5); // red over yellow(8)
const overBlack = placement.place(5, 5, 11); // cyan into the box hole then over black edge
pendingHint = placement.pendingCount;
save("04-refused-optimistic.png", surface); // both painted optimistically

// cooldown frame (no cid) rolls back the OLDEST un-acked op → overYellow
placement.handle({ t: "cooldown", until: NOW + 5000 });
pendingHint = placement.pendingCount;
save("05-cooldown-rollback.png", surface); // yellow restored

// banned error (CA6) rolls back its op by cid → overBlack
if (overBlack) placement.handle({ t: "error", code: "banned", message: "banned", cid: overBlack.cid! });
pendingHint = placement.pendingCount;
save("06-banned-rollback.png", surface); // box restored

void overYellow;
console.log("feedback:", feedback.join(" | "));
