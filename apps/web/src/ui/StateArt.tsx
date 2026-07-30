/**
 * Pixel-art decorative motifs for G9 state screens (FEN-622).
 *
 * Each motif is a 80×80 inline SVG, aria-hidden (purely decorative).
 * Pixels are 8×8px with a 2px gap (step=10). Gray fills use design tokens
 * so the art adapts to any direction without hard-coded colours.
 * Accent pixel uses --accent-2 (amber) as a restrained highlight.
 *
 * Patterns are centered in the 80×80 viewBox; offset = (80 - gridSize) / 2.
 */
import type { ReactElement } from "react";

const C = 8;   // cell size
const G = 2;   // gap
const S = C + G; // step = 10

type PixelProps = { x: number; y: number; fill?: string };

function Px({ x, y, fill = "var(--gray-400)" }: PixelProps): ReactElement {
  return <rect x={x} y={y} width={C} height={C} fill={fill} />;
}

// ─── notFound — question mark (5 cols × 7 rows, offset 16, 6) ────────────────
//  .###.
//  #...#
//  ....#
//  ..##.
//  ..#..
//  .....
//  ..#.. (accent dot)
function NotFoundArt(): ReactElement {
  const ox = 16; // (80 - (5*10-2)) / 2 = 16
  const oy = 6;  // (80 - (7*10-2)) / 2 = 6
  const p = (c: number, r: number, fill?: string) => (
    <Px key={`${c}-${r}`} x={ox + c * S} y={oy + r * S} fill={fill} />
  );
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Row 0: .###. */}
      {p(1, 0)} {p(2, 0)} {p(3, 0)}
      {/* Row 1: #...# */}
      {p(0, 1)} {p(4, 1)}
      {/* Row 2: ....# */}
      {p(4, 2)}
      {/* Row 3: ..##. */}
      {p(2, 3)} {p(3, 3)}
      {/* Row 4: ..#.. */}
      {p(2, 4)}
      {/* Row 5: empty */}
      {/* Row 6: ..#.. (accent) */}
      {p(2, 6, "var(--accent-2)")}
    </svg>
  );
}

// ─── error — exclamation mark (3 cols × 5 rows, offset 26, 16) ───────────────
//  .#.
//  .#.
//  .#.
//  ...
//  .#. (accent dot)
function ErrorArt(): ReactElement {
  const ox = 26; // (80 - (3*10-2)) / 2 = 26
  const oy = 16; // (80 - (5*10-2)) / 2 = 16
  const p = (c: number, r: number, fill?: string) => (
    <Px key={`${c}-${r}`} x={ox + c * S} y={oy + r * S} fill={fill} />
  );
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Shaft */}
      {p(1, 0)} {p(1, 1)} {p(1, 2)}
      {/* Gap (row 3 empty) */}
      {/* Dot (accent) */}
      {p(1, 4, "var(--accent-2)")}
    </svg>
  );
}

// ─── canvasGone — empty frame with broken corner (5×5, offset 16, 16) ────────
//  #####
//  #...#
//  #...#
//  #...#
//  ####.  ← missing bottom-right corner
function CanvasGoneArt(): ReactElement {
  const ox = 16;
  const oy = 16;
  const p = (c: number, r: number, fill?: string) => (
    <Px key={`${c}-${r}`} x={ox + c * S} y={oy + r * S} fill={fill} />
  );
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Top row */}
      {p(0, 0)} {p(1, 0)} {p(2, 0)} {p(3, 0)} {p(4, 0)}
      {/* Sides */}
      {p(0, 1)} {p(4, 1)}
      {p(0, 2)} {p(4, 2)}
      {p(0, 3)} {p(4, 3)}
      {/* Bottom row — broken (no corner) */}
      {p(0, 4)} {p(1, 4)} {p(2, 4)} {p(3, 4)}
      {/* Missing pixel hint with accent */}
      {p(4, 4, "var(--gray-200)")}
    </svg>
  );
}

// ─── emptyList — Z shape ("zzz", no channels) (5×5, offset 16, 16) ──────────
//  .####
//  ...#.
//  ..#.. (accent)
//  .#...
//  ####.
function EmptyListArt(): ReactElement {
  const ox = 16;
  const oy = 16;
  const p = (c: number, r: number, fill?: string) => (
    <Px key={`${c}-${r}`} x={ox + c * S} y={oy + r * S} fill={fill} />
  );
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Top bar */}
      {p(1, 0)} {p(2, 0)} {p(3, 0)} {p(4, 0)}
      {/* Diagonal */}
      {p(3, 1)}
      {p(2, 2, "var(--accent-2)")}
      {p(1, 3)}
      {/* Bottom bar */}
      {p(0, 4)} {p(1, 4)} {p(2, 4)} {p(3, 4)}
    </svg>
  );
}

// ─── emptyGallery — empty picture frame (5×5, offset 16, 16) ─────────────────
//  #####
//  #...#
//  #...#
//  #...#
//  #####
function EmptyGalleryArt(): ReactElement {
  const ox = 16;
  const oy = 16;
  const p = (c: number, r: number, fill?: string) => (
    <Px key={`${c}-${r}`} x={ox + c * S} y={oy + r * S} fill={fill} />
  );
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Top row */}
      {p(0, 0)} {p(1, 0)} {p(2, 0)} {p(3, 0)} {p(4, 0)}
      {/* Sides */}
      {p(0, 1)} {p(4, 1)}
      {p(0, 2)} {p(4, 2)}
      {p(0, 3)} {p(4, 3)}
      {/* Bottom row */}
      {p(0, 4)} {p(1, 4)} {p(2, 4)} {p(3, 4)} {p(4, 4)}
    </svg>
  );
}

/** Pixel-art decorative motifs — one per G9 state. All are `aria-hidden`. */
export const StateArt = {
  notFound: NotFoundArt,
  error: ErrorArt,
  canvasGone: CanvasGoneArt,
  emptyList: EmptyListArt,
  emptyGallery: EmptyGalleryArt,
} as const;
