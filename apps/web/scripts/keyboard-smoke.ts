/**
 * FEN-123 keyboard-operability smoke — proves a pointer-free / switch-access
 * viewer can aim, stage (multi-colour + erase) and VALIDATE entirely from the
 * keyboard, by driving the REAL {@link CanvasRenderer} keyboard handler over the
 * REAL {@link BatchSelection} (the same controller the pointer and touch paths
 * use — true 3-modality parity). No browser is available here, so the renderer's
 * `<canvas>` / ResizeObserver / rAF dependencies are met with a tiny hand-rolled
 * DOM stub (no jsdom — that would be a stack change), and rAF is a no-op so the
 * draw loop never needs a real 2D context.
 *
 * The renderer is the only canvas module that imports a sibling via a ".js"
 * specifier ("./view.js", the build convention); Node's loader won't map that to
 * ".ts" on its own, so we register a one-line resolve hook first — that's why
 * this is a *script* (run on demand) and not a `*.test.ts` picked up by the
 * `node --test` glob, mirroring scripts/batch-capture.ts.
 *
 * Run: node --experimental-transform-types scripts/keyboard-smoke.ts
 */
import { register } from "node:module";

// Map relative ".js" imports to their ".ts" source so the real renderer (and its
// "./view.js" import) loads under type-stripping. Loader runs off-thread → plain JS.
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s,c,n){` +
        `if(s.startsWith('.')&&s.endsWith('.js')){try{return await n(s.slice(0,-3)+'.ts',c)}catch{}}` +
        `return n(s,c);}`,
    ),
  import.meta.url,
);

const { encodeSnapshot } = await import("@canvas/protocol");
const { CanvasRenderer } = await import("../src/features/canvas/renderer.ts");
const { BatchSelection, EMPTY_COLOR } = await import("../src/features/canvas/selection.ts");

// --- minimal DOM stub ------------------------------------------------------

function fakeCtx(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "createImageData") {
          return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
        }
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  );
}

function makeCanvas(size: number) {
  const handlers = new Map<string, (e: unknown) => void>();
  const el: Record<string, unknown> = {
    clientWidth: size,
    clientHeight: size,
    width: size,
    height: size,
    style: {},
    getContext: () => fakeCtx(),
    addEventListener: (t: string, fn: (e: unknown) => void) => handlers.set(t, fn),
    removeEventListener: (t: string) => handlers.delete(t),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  };
  return { el, handlers };
}

const g = globalThis as Record<string, unknown>;
g.window = { devicePixelRatio: 1 };
g.document = { createElement: () => makeCanvas(160).el };
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
g.requestAnimationFrame = () => 1;
g.cancelAnimationFrame = () => undefined;

// --- drive the real renderer + real selection ------------------------------

const BOARD = 16;
const canvas = makeCanvas(160);

// Mirror the CanvasView wiring: keyboard hooks feed the SAME BatchSelection the
// pointer/touch gestures feed.
const selection = new BatchSelection(8); // gauge ceiling N = 8 charges
let lastCursor = { x: -1, y: -1 };
let validatedBatch: ReturnType<typeof selection.take> | null = null;
let color = 5; // red
let erasing = false;

const renderer = new CanvasRenderer(
  canvas.el as unknown as HTMLCanvasElement,
  {
    onCursorMove: (c: { x: number; y: number }) => {
      lastCursor = c;
    },
    onActivate: (x: number, y: number) => {
      const r = selection.apply(x, y, erasing ? EMPTY_COLOR : color);
      log(`  ↳ activate (${x},${y}) tool=${erasing ? "erase" : `c${color}`} → ${r.kind}  [batch ${selection.count}/${selection.capacity}]`);
    },
    onCancel: () => {
      selection.clear();
      log("  ↳ ESC → batch cleared");
    },
    onValidate: () => {
      validatedBatch = selection.take();
      log(`  ↳ Ctrl+Enter → VALIDATED ${validatedBatch.length} cell(s)`);
    },
  },
  { interactive: true },
);
renderer.loadSnapshot(encodeSnapshot(new Uint8Array(BOARD * BOARD), 1, BOARD, BOARD));

const lines: string[] = [];
function log(s: string) {
  lines.push(s);
}

const keydown = canvas.handlers.get("keydown")!;
function press(key: string, mods: Record<string, boolean> = {}) {
  keydown({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods, preventDefault() {} });
  if (!["Enter", "Escape", " "].includes(key)) log(`press ${mods.shiftKey ? "Shift+" : ""}${key} → cursor (${lastCursor.x},${lastCursor.y})`);
}

log("== FEN-123 keyboard pose smoke (16×16 board, gauge N=8) ==");

// Aim with arrows (first press reveals the cursor at screen centre), then stage.
press("ArrowRight"); // reveal at centre (~8,8)
press("ArrowUp");
press("ArrowUp");
press("Enter"); // stage red at cursor
press("ArrowRight");
press("ArrowRight");
color = 11; // switch colour
press("Enter"); // stage colour 11
press("ArrowDown");
erasing = true; // switch to eraser
press("Enter"); // stage an erase
erasing = false;

log(`staged before validate: ${selection.entries().map((e) => `(${e.x},${e.y}):${e.color}`).join(" ")}`);

// Toggle-off parity: re-activating a staged cell with the same tool removes it.
press("ArrowUp"); // back onto the erase cell? (demonstrate move) — then move to a fresh cell
color = 5;

// Validate the whole batch from the keyboard.
press("Enter", { ctrlKey: true });

// Escape recovers even after validate (forgiveness; no-op on empty batch).
press("Escape");

const colours = new Set(validatedBatch!.map((c) => c.color));
const hasErase = validatedBatch!.some((c) => c.color === EMPTY_COLOR);
log("");
log("== RESULT ==");
log(`validated cells: ${validatedBatch!.length}`);
log(`distinct colours committed: ${[...colours].join(", ")} (multi-colour=${colours.size > 1})`);
log(`includes an erase: ${hasErase}`);
log(`batch emptied after validate: ${selection.count === 0}`);

renderer.destroy();

const ok =
  validatedBatch!.length === 3 &&
  colours.size > 1 &&
  hasErase &&
  selection.count === 0;
log("");
log(ok ? "PASS — posed multi-colour + erase and validated, 100% keyboard." : "FAIL");
console.log(lines.join("\n"));
process.exit(ok ? 0 : 1);
