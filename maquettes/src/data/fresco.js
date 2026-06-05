// Synthetic fresco for the maquettes — NOT real user content (safety rule).
// A deterministic generator builds a small community-style pixel scene so we can
// prove §5.1 (color fidelity, white/light pixels legible) without hand-placing
// hundreds of cells. 16-colour default palette.

export const PALETTE = [
  { id: "white",   hex: "#ffffff", name: "Blanc" },
  { id: "silver",  hex: "#c7ccd4", name: "Argent" },
  { id: "gray",    hex: "#6c727c", name: "Gris" },
  { id: "black",   hex: "#15171c", name: "Noir" },
  { id: "red",     hex: "#e6402b", name: "Rouge" },
  { id: "coral",   hex: "#ff8a5c", name: "Corail" },
  { id: "amber",   hex: "#f5b21a", name: "Ambre" },
  { id: "yellow",  hex: "#ffe14d", name: "Jaune" },
  { id: "lime",    hex: "#8fd14f", name: "Citron" },
  { id: "green",   hex: "#2faa57", name: "Vert" },
  { id: "teal",    hex: "#16b8a6", name: "Turquoise" },
  { id: "sky",     hex: "#4ab6f0", name: "Ciel" },
  { id: "blue",    hex: "#2d63d6", name: "Bleu" },
  { id: "indigo",  hex: "#5b4ad6", name: "Indigo" },
  { id: "magenta", hex: "#d64ab0", name: "Magenta" },
  { id: "pink",    hex: "#ffb3c8", name: "Rose" },
];

const HEX = Object.fromEntries(PALETTE.map((c) => [c.id, c.hex]));

export const FRESCO_W = 64;
export const FRESCO_H = 40;

// Build the scene as a flat array of hex strings (null = empty / shows backing).
export function buildFresco() {
  const W = FRESCO_W, H = FRESCO_H;
  const grid = new Array(W * H).fill(null);
  const set = (x, y, id) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    grid[y * W + x] = HEX[id];
  };

  // Sky gradient bands (sky -> light), ground band of green.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y > H - 7) set(x, y, y > H - 3 ? "green" : "lime");
      else if (y < 5) set(x, y, "sky");
    }
  }
  // Sun, top-left.
  for (let y = 4; y <= 9; y++)
    for (let x = 6; x <= 11; x++)
      if ((x - 8.5) ** 2 + (y - 6.5) ** 2 <= 7) set(x, y, "amber");
  set(8, 6, "yellow"); set(9, 6, "yellow"); set(8, 7, "yellow");

  // White clouds — the legibility stress test (white on light backing).
  const cloud = (cx, cy) => {
    [[0,0],[1,0],[2,0],[-1,1],[0,1],[1,1],[2,1],[3,1],[0,-1],[1,-1]].forEach(
      ([dx, dy]) => set(cx + dx, cy + dy, "white")
    );
    set(cx + 1, cy, "silver");
  };
  cloud(40, 6); cloud(22, 9); cloud(52, 11);

  // A pixel heart (community signature), center.
  const heart = [
    "0110110",
    "1111111",
    "1111111",
    "0111110",
    "0011100",
    "0001000",
  ];
  heart.forEach((row, ry) =>
    [...row].forEach((c, rx) => { if (c === "1") set(26 + rx, 16 + ry, "red"); })
  );

  // "GG" in pixels (gaming wink), bottom-right-ish.
  const G = ["111","100","101","111"];
  const drawGlyph = (g, ox, oy, id) =>
    g.forEach((row, ry) => [...row].forEach((c, rx) => { if (c === "1") set(ox + rx, oy + ry, id); }));
  drawGlyph(G, 44, 22, "indigo");
  drawGlyph(G, 49, 22, "indigo");

  // A little house, left ground.
  for (let y = 28; y <= 33; y++) for (let x = 9; x <= 16; x++) set(x, y, "coral");
  for (let i = 0; i <= 4; i++) { set(8 + i, 28 - i + 4, "black"); set(17 - i, 28 - i + 4, "black"); }
  for (let y = 24; y <= 27; y++) for (let x = 12 - (27 - y); x <= 13 + (27 - y); x++) set(x, y, "red");
  set(12, 31, "yellow"); set(13, 31, "yellow"); // window

  // Scattered community pixels for liveliness (deterministic pseudo-random).
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const scatterIds = ["teal", "magenta", "pink", "blue", "lime", "silver"];
  for (let i = 0; i < 60; i++) {
    const x = Math.floor(rnd() * W);
    const y = 6 + Math.floor(rnd() * (H - 14));
    if (!grid[y * W + x]) set(x, y, scatterIds[Math.floor(rnd() * scatterIds.length)]);
  }

  return grid;
}
