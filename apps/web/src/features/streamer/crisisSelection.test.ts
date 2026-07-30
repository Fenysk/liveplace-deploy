/**
 * Crisis ban/wipe/restore selection logic — Definition-of-Done ([FEN-160],
 * spec FEN-157 §2/§3/§4 + §6 acceptance). Logic-only (no DOM/Convex), matching
 * the web `test` script. Covers the destructive-action invariants the spec turns
 * on:
 *   - marquee geometry clamps to canvas bounds; live count is cheap + exact (§3)
 *   - the large-wipe soft warning fires on the fixed floor OR the 25% fraction (§3)
 *   - ban resolution branches empty / protected / confirm, with blast-radius
 *     fallback to "tous ses pixels" when the preview is absent (§2)
 *   - a dispatch result distinguishes CLEAN success from the `gateway_not_configured`
 *     neutral caveat from an error — the false-safety guard (§2.6)
 *   - the undo list keeps only reversible removals + marks restored rows (§4)
 *   - every returned i18n key resolves in BOTH catalogs (FR/EN parity, C6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rectCells,
  rectCellCount,
  rectOutlineCells,
  wipeIsLarge,
  WIPE_WARN_THRESHOLD,
  resolveBanPick,
  banConfirmView,
  wipeConfirmView,
  wipeCountAnnounce,
  classifyResult,
  resultAnnounce,
  cancelledAnnounce,
  buildUndoList,
  restoreConfirmView,
  restoreResultAnnounce,
  banModeBanner,
  wipeModeBanner,
  type CrisisAnnounce,
  type AuditRow,
} from "./crisisSelection.ts";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const BOUNDS = { width: 100, height: 80 };

// ── Marquee geometry (§3.2) ──────────────────────────────────────────────────

test("rectCells: inclusive rectangle, order-independent corners", () => {
  const a = rectCells({ x: 2, y: 3 }, { x: 4, y: 5 }, BOUNDS);
  assert.equal(a.length, 9); // 3×3 inclusive
  const b = rectCells({ x: 4, y: 5 }, { x: 2, y: 3 }, BOUNDS);
  assert.deepEqual(a, b); // swapping corners is the same region
  assert.deepEqual(a[0], { x: 2, y: 3 });
  assert.deepEqual(a[a.length - 1], { x: 4, y: 5 });
});

test("rectCells: clamps a region that runs past the canvas bounds (§3 clamp)", () => {
  const cells = rectCells({ x: -5, y: -5 }, { x: 1, y: 1 }, BOUNDS);
  assert.equal(cells.length, 4); // [0..1]×[0..1]
  assert.ok(cells.every((c) => c.x >= 0 && c.y >= 0));
  const far = rectCells({ x: 98, y: 78 }, { x: 200, y: 200 }, BOUNDS);
  assert.ok(far.every((c) => c.x < BOUNDS.width && c.y < BOUNDS.height));
});

test("rectCells: a fully out-of-bounds box yields no cells", () => {
  assert.deepEqual(rectCells({ x: 200, y: 200 }, { x: 300, y: 300 }, BOUNDS), []);
  assert.deepEqual(rectCells({ x: 0, y: 0 }, { x: 1, y: 1 }, { width: 0, height: 0 }), []);
});

test("rectCellCount matches rectCells.length without allocating the array", () => {
  for (const [a, b] of [
    [{ x: 0, y: 0 }, { x: 9, y: 9 }],
    [{ x: -3, y: 2 }, { x: 5, y: 50 }],
    [{ x: 50, y: 50 }, { x: 50, y: 50 }],
  ] as const) {
    assert.equal(rectCellCount(a, b, BOUNDS), rectCells(a, b, BOUNDS).length);
  }
});

test("rectOutlineCells: perimeter only, O(w+h), within the full rect", () => {
  const full = new Set(rectCells({ x: 2, y: 2 }, { x: 6, y: 5 }, BOUNDS).map((c) => `${c.x},${c.y}`));
  const outline = rectOutlineCells({ x: 2, y: 2 }, { x: 6, y: 5 }, BOUNDS);
  // a 5×4 rect → perimeter = 2*(5+4) - 4 = 14 cells (no double-counted corners)
  assert.equal(outline.length, 14);
  assert.ok(outline.every((c) => full.has(`${c.x},${c.y}`)));
  // a 1×1 selection is its own single outline cell (no duplicates)
  assert.deepEqual(rectOutlineCells({ x: 3, y: 3 }, { x: 3, y: 3 }, BOUNDS), [{ x: 3, y: 3 }]);
});

// ── Large-wipe soft warning (§3) ─────────────────────────────────────────────

test("wipeIsLarge: fires above the fixed 1000 floor", () => {
  assert.equal(wipeIsLarge(WIPE_WARN_THRESHOLD, { width: 1000, height: 1000 }), false);
  assert.equal(wipeIsLarge(WIPE_WARN_THRESHOLD + 1, { width: 1000, height: 1000 }), true);
});

test("wipeIsLarge: fires at 25% of a small canvas before the fixed floor would", () => {
  const small = { width: 40, height: 40 }; // area 1600, 25% = 400
  assert.equal(wipeIsLarge(399, small), false);
  assert.equal(wipeIsLarge(400, small), true); // ≥ fraction, well under 1000
});

test("wipeIsLarge: zero/empty never warns", () => {
  assert.equal(wipeIsLarge(0, BOUNDS), false);
  assert.equal(wipeIsLarge(5, { width: 0, height: 0 }), false);
});

// ── Ban flow (§2) ────────────────────────────────────────────────────────────

test("resolveBanPick: null author → empty-cell hint, stay in mode (§2 edge)", () => {
  const r = resolveBanPick(null, false);
  assert.equal(r.kind, "empty");
  assert.equal(r.announce.key, "studio.crisis.ban.empty");
  assert.equal(r.announce.role, "status");
});

test("resolveBanPick: protected target → blocked with reason (§2 edge)", () => {
  const r = resolveBanPick({ userId: "u1", displayName: "Mod" }, true);
  assert.equal(r.kind, "protected");
  assert.equal(r.announce.key, "studio.crisis.ban.protected");
});

test("resolveBanPick: normal author → advance to confirm", () => {
  const r = resolveBanPick({ userId: "u1", displayName: "Griefer" }, false);
  assert.equal(r.kind, "confirm");
  assert.equal(r.kind === "confirm" && r.target.displayName, "Griefer");
});

test("banConfirmView: blast radius shown when known, falls back to title-only (§2.4)", () => {
  const withCount = banConfirmView({ userId: "u1", displayName: "Griefer" }, 42, "this author");
  assert.equal(withCount.title.params?.author, "Griefer");
  assert.equal(withCount.count?.key, "studio.crisis.ban.confirmCount");
  assert.equal(withCount.count?.params?.count, 42);

  const noCount = banConfirmView({ userId: "u1" }, null, "this author");
  assert.equal(noCount.count, null); // fallback: "tous ses pixels", no number
  assert.equal(noCount.title.params?.author, "this author"); // anon fallback applied
});

// ── Wipe flow (§3) ───────────────────────────────────────────────────────────

test("wipeConfirmView: empty region disables confirm + hints (§3 empty)", () => {
  const v = wipeConfirmView(0, BOUNDS);
  assert.equal(v.canConfirm, false);
  assert.equal(v.emptyHint?.key, "studio.crisis.wipe.empty");
  assert.equal(v.largeWarning, null);
});

test("wipeConfirmView: large region adds the soft warning but stays confirmable (§3)", () => {
  const v = wipeConfirmView(5000, BOUNDS);
  assert.equal(v.canConfirm, true); // never a hard block
  assert.equal(v.largeWarning?.key, "studio.crisis.wipe.large");
  assert.equal(v.largeWarning?.params?.count, 5000);
  assert.equal(v.confirm.key, "studio.crisis.wipe.confirm");
});

test("wipeCountAnnounce: live count readout carries the count param", () => {
  assert.deepEqual(wipeCountAnnounce(42), {
    key: "studio.crisis.wipe.count",
    params: { count: 42 },
    role: "status",
  });
});

// ── Dispatch result classification (§2.6 false-safety guard) ─────────────────

test("classifyResult: dispatched → clean; gateway_not_configured → pending; else error", () => {
  assert.equal(classifyResult({ cellsAffected: 5, dispatched: true, detail: "gateway 200 /x" }), "clean");
  assert.equal(
    classifyResult({ cellsAffected: 5, dispatched: false, detail: "gateway_not_configured" }),
    "pending",
  );
  assert.equal(classifyResult({ cellsAffected: 0, dispatched: false, detail: "no_cells" }), "noop");
  assert.equal(classifyResult({ cellsAffected: 0, dispatched: false, detail: "weird" }), "error");
});

test("resultAnnounce: the pending caveat is NEVER the clean-success copy (§2.6)", () => {
  const clean = resultAnnounce("ban", { cellsAffected: 18, dispatched: true, detail: "gateway 200" });
  assert.equal(clean.key, "studio.crisis.ban.success");
  assert.equal(clean.params?.count, 18);
  assert.equal(clean.role, "status");

  const pending = resultAnnounce("ban", {
    cellsAffected: 18,
    dispatched: false,
    detail: "gateway_not_configured",
  });
  assert.equal(pending.key, "studio.crisis.ban.successPending");
  assert.notEqual(pending.key, clean.key); // distinct render, false-safety guard
  assert.equal(pending.role, "status"); // neutral, NOT role=alert

  const err = resultAnnounce("wipe", { cellsAffected: 0, dispatched: false, detail: "boom" });
  assert.equal(err.key, "studio.crisis.wipe.error");
  assert.equal(err.role, "alert"); // errors are assertive + carry "réessaie"
});

test("cancelledAnnounce: shared one-gesture escape copy (§2/§3 cancel)", () => {
  assert.equal(cancelledAnnounce().key, "studio.crisis.cancelled");
});

// ── Restore / undo list (§4) ─────────────────────────────────────────────────

const AUDIT: AuditRow[] = [
  { _id: "a1", action: "ban_wipe", targetUserId: "u9", cellsAffected: 18, createdAt: 3000 },
  { _id: "a2", action: "delete", cellsAffected: 42, createdAt: 2000 },
  { _id: "a3", action: "freeze", cellsAffected: 0, createdAt: 1000 }, // not reversible — filtered
  { _id: "a4", action: "restore", cellsAffected: 5, createdAt: 500 }, // not a removal — filtered
];

test("buildUndoList: keeps only reversible removals, newest-first preserved (§4)", () => {
  const rows = buildUndoList(AUDIT, new Set(), "this author");
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a2"]);
  const [ban, wipe] = rows;
  assert.equal(ban!.label.key, "studio.crisis.history.banRow");
  assert.equal(ban!.label.params?.count, 18);
  assert.equal(ban!.label.params?.author, "this author");
  assert.equal(wipe!.label.key, "studio.crisis.history.wipeRow");
  assert.equal(wipe!.label.params?.count, 42);
});

test("buildUndoList: a restored id marks its row (idempotent re-restore → disabled, §4)", () => {
  const rows = buildUndoList(AUDIT, new Set(["a2"]), "this author");
  assert.equal(rows.find((r) => r.id === "a1")?.restored, false);
  assert.equal(rows.find((r) => r.id === "a2")?.restored, true);
});

test("restoreConfirmView: forewarns the overwrite of recent placements (§4)", () => {
  const v = restoreConfirmView(7);
  assert.equal(v.key, "studio.crisis.restore.confirm");
  assert.equal(v.params?.count, 7);
});

test("restoreResultAnnounce: success names the count; error is assertive", () => {
  assert.equal(
    restoreResultAnnounce({ cellsAffected: 7, dispatched: true, detail: "gateway 200" }).key,
    "studio.crisis.restore.success",
  );
  const err = restoreResultAnnounce({ cellsAffected: 0, dispatched: false, detail: "boom" });
  assert.equal(err.key, "studio.crisis.history.error");
  assert.equal(err.role, "alert");
});

// ── FR/EN parity (C6 / acceptance §6.6) ──────────────────────────────────────

/** Pull the announce off a non-confirm ban outcome (empty/protected) for parity. */
function banOutcomeAnnounce(o: ReturnType<typeof resolveBanPick>): CrisisAnnounce {
  assert.notEqual(o.kind, "confirm");
  return (o as Extract<typeof o, { announce: CrisisAnnounce }>).announce;
}

test("every returned i18n key resolves in BOTH catalogs (FR/EN parity, C6)", () => {
  const announces: CrisisAnnounce[] = [
    banModeBanner(),
    wipeModeBanner(),
    banOutcomeAnnounce(resolveBanPick(null, false)),
    banOutcomeAnnounce(resolveBanPick({ userId: "u" }, true)),
    banConfirmView({ userId: "u", displayName: "X" }, 5, "this author").title,
    banConfirmView({ userId: "u", displayName: "X" }, 5, "this author").count!,
    wipeCountAnnounce(1),
    wipeConfirmView(0, BOUNDS).emptyHint!,
    wipeConfirmView(5000, BOUNDS).largeWarning!,
    wipeConfirmView(5000, BOUNDS).confirm,
    resultAnnounce("ban", { cellsAffected: 1, dispatched: true, detail: "" }),
    resultAnnounce("ban", { cellsAffected: 1, dispatched: false, detail: "gateway_not_configured" }),
    resultAnnounce("ban", { cellsAffected: 0, dispatched: false, detail: "x" }),
    resultAnnounce("wipe", { cellsAffected: 1, dispatched: true, detail: "" }),
    resultAnnounce("wipe", { cellsAffected: 1, dispatched: false, detail: "gateway_not_configured" }),
    resultAnnounce("wipe", { cellsAffected: 0, dispatched: false, detail: "x" }),
    cancelledAnnounce(),
    buildUndoList(AUDIT, new Set(), "this author")[0]!.label,
    buildUndoList(AUDIT, new Set(), "this author")[1]!.label,
    restoreConfirmView(3),
    restoreResultAnnounce({ cellsAffected: 3, dispatched: true, detail: "" }),
    restoreResultAnnounce({ cellsAffected: 0, dispatched: false, detail: "x" }),
  ];
  // extra keys the surfaces resolve directly (labels/headers not returned as Announce)
  const extra = [
    "studio.crisis.ban.anonAuthor",
    "studio.crisis.cancel",
    "studio.crisis.history.title",
    "studio.crisis.history.empty",
    "studio.crisis.history.restored",
    "studio.crisis.restore",
  ];
  for (const k of new Set([...announces.map((a) => a.key), ...extra])) {
    assert.ok(k in en, `missing EN key: ${k}`);
    assert.ok(k in fr, `missing FR key: ${k}`);
  }
});
