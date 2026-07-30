/**
 * FEN-113 batch-pose visual-capture harness — renders the "sélection →
 * validation" flow to PNGs WITHOUT a browser (none is available here). It drives
 * the REAL {@link BatchSelection} controller and the REAL
 * {@link OptimisticPlacement} over the REAL pixel buffer ({@link BufferSurface},
 * the same getPixel/setPixel contract the live CanvasRenderer mutates), and
 * rasterises the staged-selection OVERLAY exactly as {@link CanvasRenderer}'s
 * `drawOverlay` does on a <canvas> (translucent colour fill + white outline per
 * staged cell, a dashed hollow cell for an erase, a thin frame for the hover) —
 * so the captures are what the canvas would draw at each stage, in Node.
 *
 * Captures (written to apps/web/artifacts/):
 *   b1-base.png            the snapshot baseline (existing art)
 *   b2-staged.png          a 4-cell batch staged: 2 colours + 1 erase + hovered
 *   b3-committed.png       Valider → 3 cells committed, 1 refused (partial),
 *                          rolled back to its base (per-cid reconciliation)
 *
 * Run: node --experimental-transform-types scripts/batch-capture.ts
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, paletteToRGBA } from "@canvas/protocol";
import { OptimisticPlacement } from "../src/features/canvas/placement.ts";
import { BufferSurface } from "../src/features/canvas/bufferSurface.ts";
import { BatchSelection, EMPTY_COLOR, type SelectionEntry } from "../src/features/canvas/selection.ts";

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
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
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
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

// ── overlay raster (mirrors CanvasRenderer.drawOverlay) ──────────────────────

interface Overlay {
  cells: readonly SelectionEntry[];
  hover: { x: number; y: number } | null;
}

function blend(out: Uint8Array, di: number, r: number, g: number, b: number, a: number): void {
  out[di] = Math.round(out[di]! * (1 - a) + r * a);
  out[di + 1] = Math.round(out[di + 1]! * (1 - a) + g * a);
  out[di + 2] = Math.round(out[di + 2]! * (1 - a) + b * a);
}

/** Upscale the palette-indexed board to RGBA, then draw the selection overlay. */
function renderCapture(surface: BufferSurface, overlay: Overlay): Buffer {
  const cells = paletteToRGBA(surface.pixels);
  const outW = W * CELL;
  const outH = H * CELL;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const cy = Math.floor(y / CELL);
    for (let x = 0; x < outW; x++) {
      const cx = Math.floor(x / CELL);
      const si = (cy * W + cx) * 4;
      const di = (y * outW + x) * 4;
      const grid = y % CELL === 0 || x % CELL === 0;
      const dim = grid ? 0.82 : 1;
      out[di] = Math.round(cells[si]! * dim);
      out[di + 1] = Math.round(cells[si + 1]! * dim);
      out[di + 2] = Math.round(cells[si + 2]! * dim);
      out[di + 3] = 255;
    }
  }
  const stroke = (cx: number, cy: number, dashed: boolean) => {
    const x0 = cx * CELL;
    const y0 = cy * CELL;
    for (let i = 0; i < CELL; i++) {
      if (dashed && Math.floor(i / 3) % 2 === 1) continue; // dashed pattern
      for (const [px, py] of [
        [x0 + i, y0],
        [x0 + i, y0 + CELL - 1],
        [x0, y0 + i],
        [x0 + CELL - 1, y0 + i],
      ] as const) {
        const di = (py * outW + px) * 4;
        out[di] = out[di + 1] = out[di + 2] = 240;
      }
    }
  };
  for (const c of overlay.cells) {
    const x0 = c.x * CELL;
    const y0 = c.y * CELL;
    if (c.color !== EMPTY_COLOR) {
      const [r, g, b] = PALETTE[c.color] ?? [255, 255, 255];
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) blend(out, ((y0 + y) * outW + (x0 + x)) * 4, r!, g!, b!, 0.55);
      }
      stroke(c.x, c.y, false);
    } else {
      stroke(c.x, c.y, true); // erase = hollow dashed cell
    }
  }
  if (overlay.hover) stroke(overlay.hover.x, overlay.hover.y, false);
  return encodePng(out, outW, outH);
}

function save(name: string, surface: BufferSurface, overlay: Overlay): void {
  writeFileSync(join(OUT, name), renderCapture(surface, overlay));
  console.log(`wrote ${name}  (staged=${overlay.cells.length})`);
}

// ── scenario ─────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const surface = new BufferSurface(W, H, 0);
const seed: Array<[number, number, number]> = [
  [4, 4, 16], [5, 4, 16], [6, 4, 16], [4, 5, 16], [6, 5, 16], [4, 6, 16], [5, 6, 16], [6, 6, 16], // black box
  [12, 12, 8], [13, 12, 8], [12, 13, 8], [13, 13, 8], // yellow block (an erase target)
];
for (const [x, y, c] of seed) surface.setPixel(x, y, c);

const NONE: Overlay = { cells: [], hover: null };
save("b1-base.png", surface, NONE);

// ── stage a batch: 2 colours + 1 erase, with a hovered cell (cap = 4) ────────
const sel = new BatchSelection(4);
sel.apply(16, 8, 5); // red
sel.apply(17, 8, 5); // red
sel.apply(18, 8, 11); // cyan (multi-colour)
sel.apply(12, 12, EMPTY_COLOR); // erase the yellow block (eraser tool)
save("b2-staged.png", surface, { cells: sel.entries(), hover: { x: 16, y: 9 } });

// ── Valider: commit the batch through OptimisticPlacement (one place/cell) ───
let cidN = 0;
const placement = new OptimisticPlacement({
  width: W,
  height: H,
  paletteSize: PALETTE.length,
  surface,
  now: () => 1_000_000,
  genCid: () => `cid-${++cidN}`,
  blockWhenEmpty: false,
});
placement.handle({ t: "gauge", charges: 4, max: 5, cooldownUntil: 0 });

const committed = sel.take();
const msgs = committed.map((c) => placement.place(c.x, c.y, c.color));
// Partial server verdict: ack cells 0,1,3; REFUSE cell 2 (cyan) → it rolls back.
[0, 1, 3].forEach((i) => {
  const m = msgs[i];
  if (m) placement.handle({ t: "ack", seq: 0, cid: m.cid!, charges: 3 - i, max: 5, cooldownUntil: 0 });
});
const refused = msgs[2];
if (refused) placement.handle({ t: "error", code: "rate_limited", message: "slow down", cid: refused.cid! });

save("b3-committed.png", surface, NONE);
console.log(`committed=${committed.length} pendingAfter=${placement.pendingCount} (cyan refused → rolled back)`);
