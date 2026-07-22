/**
 * C5 harness — Espace maintenu continu + stop jauge vide (FEN-1769)
 *
 * Prouve C5 de FEN-1726 : « Espace maintenu en mode dessin = sélection
 * continue de tout pixel sous la souris, gâtée par la jauge. »
 *
 * Stratégie : harness pure-logique utilisant les fonctions extraites de
 * spaceHoldPaint.ts (FEN-1948) — le module importe le vrai code de production,
 * plus aucune copie verbatim. BatchSelection et armingCapacity viennent
 * également du vrai code de production.
 *
 * Pourquoi pas un mount composant : CanvasView dépend de CanvasRenderer
 * (requiert un <canvas> 2D contextuel, absent dans le runner node --test),
 * de providers Convex, et d'une connexion WS pour l'état de jauge — aucun
 * de ces éléments n'est mockable sans DOM/jsdom + vi.mock() que le harness
 * `node --test` du projet ne fournit pas. Le harness ci-dessous exerce les
 * mêmes chemins de branche avec le vrai BatchSelection, couvrant les 3
 * assertions C5 sans round-trip serveur. (C11 doc inline : point de blocage
 * = CanvasRenderer + providers Convex non mockables en node --test pur.)
 *
 * Commande : pnpm --filter @canvas/web test --test-name-pattern "C5"
 * (ou) node --experimental-transform-types --test \
 *        apps/web/src/features/canvas/c5SpaceHoldPaint.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchSelection } from "./selection.ts";
import { armingCapacity } from "./cooldown.ts";
import {
  type SpaceHoldCtx,
  applySpaceHold,
  applyHoverSpacePaint,
  releaseSpacePaint,
} from "./spaceHoldPaint.ts";

// ─── Harness ────────────────────────────────────────────────────────────────
// Réplique les refs de CanvasView et câble les fonctions extraites de
// spaceHoldPaint.ts.

interface C5Harness {
  spacePaintingRef: { current: boolean };
  /** Délègue à applySpaceHold (spaceHoldPaint.ts). */
  onSpaceHold: (held: boolean) => void;
  /** Met à jour hoverRef puis délègue à applyHoverSpacePaint. */
  onHover: (cell: { x: number; y: number } | null) => void;
  /** Délègue à releaseSpacePaint pour code === "Space". */
  onKeyUp: (code: string) => void;
  /** Simule la réception d'un frame de jauge à 0 charges. */
  drainGauge: () => void;
  sel: BatchSelection;
}

function makeC5Harness(initialCharges: number): C5Harness {
  // Refs miroir de CanvasView.
  const spacePaintingRef = { current: false };
  const drawingRef = { current: true };  // mode dessin actif
  const hoverRef = { current: null as { x: number; y: number } | null };

  // Auth toujours passante (session mockée).
  const requireAccount = () => true;

  // canArmNow : dans CanvasView = placeState.canPlace || placeState.kind === "cooldown".
  // Avec charges > 0 → canPlace = true. Avec charges = 0 → cooldown = true.
  // Dans les deux cas canArmNowRef.current = true ; c'est setCapacity qui gate les ajouts.
  const canArmNowRef = { current: true };

  // La capacité mirore CanvasView.tsx l.1032 :
  // setCapacity(armingCapacity(eff, eff <= 0 && gauge !== null))
  let currentCharges = initialCharges;
  const gaugeKnown = true; // gauge !== null (reçue du serveur)
  const sel = new BatchSelection(
    armingCapacity(currentCharges, currentCharges <= 0 && gaugeKnown),
  );

  // stageCell — logique simplifiée, fidèle à CanvasView.tsx l.684-716.
  // (Pas de toast / overlay / coach : hors du chemin C5.)
  const stageCell = (x: number, y: number, { onlyAdd = false }: { onlyAdd?: boolean } = {}): void => {
    if (!requireAccount()) return;
    if (!canArmNowRef.current && !sel.has(x, y)) return; // rejeté (hors scope C5)
    // AC2 (FEN-1780): SET semantics — skip if already staged with same colour.
    if (onlyAdd && sel.colorAt(x, y) === 1) return;
    sel.apply(x, y, 1); // couleur fixe 1 (non pertinent pour C5)
    // "cap" → silencieux §5.5 ; "locked" → hors scope C5.
  };

  const spaceCtx: SpaceHoldCtx = { spacePaintingRef, drawingRef, hoverRef, stageCell };

  const onSpaceHold = (held: boolean): void => applySpaceHold(held, spaceCtx);

  const onHover = (cell: { x: number; y: number } | null): void => {
    hoverRef.current = cell;
    // rendererRef.current?.setOverlay(...) → skipped (pas de renderer en test)
    applyHoverSpacePaint(cell, spaceCtx);
  };

  const onKeyUp = (code: string): void => {
    if (code === "Space") releaseSpacePaint(spaceCtx);
  };

  // Simule CanvasView.tsx l.1031-1033 : gauge frame charges=0.
  const drainGauge = (): void => {
    currentCharges = 0;
    sel.setCapacity(armingCapacity(0, /* onCooldown: 0 <= 0 = true */ gaugeKnown));
    // armingCapacity(0, true) = 1 (Lot F : une cellule pré-visée autorisée)
  };

  return { spacePaintingRef, onSpaceHold, onHover, onKeyUp, drainGauge, sel };
}

// ─── Assertion 1 — sélection continue par pixel ─────────────────────────────
// C5 §2 : « keydown Espace maintenu → déplace la souris sur plusieurs pixels
//          → le callback de placement est invoqué une fois par pixel survolé. »

test("C5-A1 — Space maintenu + draw mode : un pixel stagé par hover (continu)", () => {
  const h = makeC5Harness(5); // 5 charges disponibles

  // Curseur positionné sur (0,0) AVANT l'appui Espace (simule le hover actif).
  h.onHover({ x: 0, y: 0 }); // no-op : Space pas encore tenu
  assert.equal(h.sel.count, 0, "pas de staging sans Space");

  // Espace enfoncé → stage immédiatement la cellule sous le curseur.
  h.onSpaceHold(true);
  assert.equal(h.sel.count, 1, "hover cell (0,0) stagée à l'appui Espace");

  // Déplacement sur 3 pixels distincts pendant que Space est tenu.
  h.onHover({ x: 1, y: 0 });
  h.onHover({ x: 2, y: 0 });
  h.onHover({ x: 3, y: 0 });

  assert.equal(h.sel.count, 4, "4 pixels stagés : 1 à l'appui + 3 hovers");
  assert.ok(h.sel.has(0, 0), "pixel (0,0) stagé");
  assert.ok(h.sel.has(1, 0), "pixel (1,0) stagé");
  assert.ok(h.sel.has(2, 0), "pixel (2,0) stagé");
  assert.ok(h.sel.has(3, 0), "pixel (3,0) stagé");
});

// ─── Assertion 2 — stop quand jauge vide ────────────────────────────────────
// C5 §3 : « Vide la jauge (state → 0) pendant le maintien → le placement
//          s'arrête (plus aucun pixel ajouté), même Espace toujours enfoncé. »

test("C5-A2 — jauge vidée à 0 : plus aucun pixel ajouté même Space tenu", () => {
  const h = makeC5Harness(5); // 5 charges au départ

  // Stage 3 pixels avec jauge pleine.
  h.onSpaceHold(true);     // pas de hover initial → count=0
  h.onHover({ x: 0, y: 0 }); // count=1
  h.onHover({ x: 1, y: 0 }); // count=2
  h.onHover({ x: 2, y: 0 }); // count=3

  assert.equal(h.sel.count, 3);

  // Jauge tombe à 0 (frame gauge reçu du WS → setCapacity(1) via armingCapacity).
  h.drainGauge();
  // Lot F : capacity = 1 maintenant ; count=3 > capacity=1, canAddMore=false.
  assert.equal(h.sel.canAddMore, false, "capacity réduite à 1 (Lot F), canAddMore=false");

  const countBeforeDrain = h.sel.count;

  // Hovers supplémentaires pendant Space tenu : aucun nouveau pixel stagé.
  h.onHover({ x: 3, y: 0 }); // refusé (cap silencieux §5.5)
  h.onHover({ x: 4, y: 0 }); // refusé
  h.onHover({ x: 5, y: 0 }); // refusé

  assert.equal(
    h.sel.count,
    countBeforeDrain,
    "aucun pixel supplémentaire après vidange de la jauge",
  );
  assert.ok(!h.sel.has(3, 0), "pixel (3,0) non stagé");
  assert.ok(!h.sel.has(4, 0), "pixel (4,0) non stagé");
  assert.ok(!h.sel.has(5, 0), "pixel (5,0) non stagé");
  assert.ok(h.spacePaintingRef.current, "Space toujours physiquement tenu");
});

// ─── Assertion 4 — SET semantics : revisit ne toggle pas ────────────────────
// AC2 (FEN-1780): « Espace maintenu = set, pas toggle : repasser sur un pixel
// déjà stagé ne le retire jamais. »

test("C5-A4 — revisit d'une cellule déjà stagée : SET (jamais de toggle)", () => {
  const h = makeC5Harness(5);

  // Espace tenu, premier passage sur (0,0).
  h.onSpaceHold(true);
  h.onHover({ x: 0, y: 0 }); // stagé → count=1
  assert.equal(h.sel.count, 1, "pixel (0,0) stagé");

  // Re-passage sur la même cellule (curseur revient sur (0,0)).
  h.onHover({ x: 0, y: 0 });
  assert.equal(h.sel.count, 1, "re-survolé : SET → toujours stagé, pas de toggle");
  assert.ok(h.sel.has(0, 0), "pixel (0,0) toujours présent après re-survol");

  // Re-passage supplémentaire : idem.
  h.onHover({ x: 0, y: 0 });
  assert.equal(h.sel.count, 1, "3e passage : toujours stagé, count=1");
});

// ─── Assertion 5 — pré-armement avant entrée en mode dessin ─────────────────
// FEN-2014: Space hors draw mode → useCanvasKeyboard appelle enterDrawMode()
// ET arme spacePaintingRef avant le re-render. Prouve que :
// • applyHoverSpacePaint ne stage PAS quand drawingRef=false (sécurité)
// • dès que drawingRef devient true, le prochain hover stage la cellule.

test("C5-A5 — pré-armement : pas de staging avant draw mode, painting démarre dès activation", () => {
  const spacePaintingRef = { current: false };
  const drawingRef = { current: false }; // pas encore en draw mode
  const hoverRef: { current: { x: number; y: number } | null } = { current: null };
  const sel = new BatchSelection(5);
  const stageCell = (x: number, y: number, opts?: { onlyAdd?: boolean }): void => {
    sel.apply(x, y, 1);
  };
  const ctx = { spacePaintingRef, drawingRef, hoverRef, stageCell };

  // Simule useCanvasKeyboard : Space hors draw mode → pré-arme spacePaintingRef.
  spacePaintingRef.current = true; // enterDrawMode() + pre-arm
  hoverRef.current = { x: 3, y: 3 };

  // Avant activation du draw mode : applyHoverSpacePaint ne stage pas.
  applyHoverSpacePaint({ x: 3, y: 3 }, ctx);
  assert.equal(sel.count, 0, "pas de staging quand drawingRef=false même si spacePaintingRef=true");

  // draw mode s'active (async setState résolu après re-render).
  drawingRef.current = true;

  // Prochain hover → stage maintenant.
  applyHoverSpacePaint({ x: 3, y: 3 }, ctx);
  assert.equal(sel.count, 1, "staging dès que drawingRef=true après pré-armement");
  assert.ok(sel.has(3, 3), "pixel (3,3) stagé");

  // keyup Space → désarme.
  releaseSpacePaint(ctx);
  applyHoverSpacePaint({ x: 4, y: 3 }, ctx);
  assert.equal(sel.count, 1, "aucun staging après keyup Space");
});

// ─── Assertion 3 — désarmement keyup ────────────────────────────────────────
// C5 §4 : « keyup Espace → le mode continu se désarme. »

test("C5-A3 — keyup Space : désarme le mode peinture continue", () => {
  const h = makeC5Harness(5);

  // Phase active : Space tenu, pixels stagés.
  h.onSpaceHold(true);
  h.onHover({ x: 0, y: 0 }); // count=1
  h.onHover({ x: 1, y: 0 }); // count=2

  assert.equal(h.spacePaintingRef.current, true);
  assert.equal(h.sel.count, 2);

  // Relâchement de la touche Espace.
  h.onKeyUp("Space");

  assert.equal(
    h.spacePaintingRef.current,
    false,
    "spacePaintingRef désarmé après keyup",
  );

  // Hovers après relâchement : aucun nouveau staging.
  const countAfterKeyup = h.sel.count;
  h.onHover({ x: 2, y: 0 });
  h.onHover({ x: 3, y: 0 });

  assert.equal(
    h.sel.count,
    countAfterKeyup,
    "aucun pixel stagé après keyup Space",
  );
  assert.ok(!h.sel.has(2, 0), "pixel (2,0) non stagé après keyup");
  assert.ok(!h.sel.has(3, 0), "pixel (3,0) non stagé après keyup");
});
