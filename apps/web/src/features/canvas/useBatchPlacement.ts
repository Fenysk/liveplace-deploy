/**
 * Batch-selection, tier-claim, and cooldown logic (FEN-113 / Lot D / Lot F).
 *
 * Extracted from CanvasView.tsx so the pose state machine — staging, validating,
 * cancelling, claiming tiers, and deriving cooldown + gauge views — lives in an
 * isolated unit. CanvasView retains `placeState` (needs Convex `permission`) and
 * writes back to the shared refs after derivation.
 *
 * Shared refs contract: `canPlaceNowRef`, `canArmNowRef`, `onCooldownRef`,
 * `cooldownSecondsRef`, `blockedMsgRef` are RETURNED (not copied) — CanvasView
 * writes to them after deriving `placeState`, and the bound-once renderer/tap
 * callbacks read through the same object.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GaugeState } from "@canvas/protocol";
import type { MessageKey } from "@canvas/i18n";
import { BatchSelection, EMPTY_COLOR } from "./selection.js";
import { TierClaim, type TierSource } from "./tierClaim.js";
import { deriveCooldownView, armingCapacity, type CooldownView } from "./cooldown.js";
import { cooldownRingPercent } from "./canvasArcade.js";
import type { CanvasInteraction } from "./authGate.js";
import type { CanvasRenderer } from "./renderer.js";
import type { CanvasNetClient } from "./net.js";
import type { OptimisticPlacement } from "./placement.js";
import {
  loadReturnIntent,
  clearReturnIntent,
  loadBatch,
  clearBatch,
} from "../../auth/return-trip.js";


interface UseBatchPlacementInput {
  gauge: GaugeState | null;
  tierSource: TierSource;
  slug: string | null;
  convexAuthed: boolean;
  requireAccount: (interaction: CanvasInteraction) => boolean;
  showToast: (f: { kind: string; messageKey: string; params?: Record<string, string | number> }) => void;
  netRef: React.MutableRefObject<CanvasNetClient | null>;
  rendererRef: React.MutableRefObject<CanvasRenderer | null>;
  hoverRef: React.MutableRefObject<{ x: number; y: number } | null>;
  placementRef: React.MutableRefObject<OptimisticPlacement | null>;
  closeInspect: () => void;
  openPanel: () => void;
  setDrawing: React.Dispatch<React.SetStateAction<boolean>>;
  drawingRef: React.MutableRefObject<boolean>;
  erasingRef: React.MutableRefObject<boolean>;
  colorRef: React.MutableRefObject<number>;
  playGaugeFullRef: React.MutableRefObject<() => void>;
}

export function useBatchPlacement({
  gauge,
  tierSource,
  slug,
  convexAuthed,
  requireAccount,
  showToast,
  netRef,
  rendererRef,
  hoverRef,
  placementRef,
  closeInspect,
  openPanel,
  setDrawing,
  drawingRef: _drawingRef,
  erasingRef,
  colorRef,
  playGaugeFullRef,
}: UseBatchPlacementInput) {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [selVersion, setSelVersion] = useState(0); // bumped on every batch change
  const [, setTick] = useState(0); // drives the per-second cooldown countdown
  // §5.7/§7.5: brief processing state while the batch is in-flight.
  const [submitting, setSubmitting] = useState(false);
  // Stores the committed count for the button label during the submitting flash.
  const [placedCount, setPlacedCount] = useState(0);
  // Lot D — "claim de palier": `tierVersion` forces a HUD refresh whenever
  // progression or the optimistic overlay changes.
  const [tierVersion, setTierVersion] = useState(0);

  // ─── Refs ───────────────────────────────────────────────────────────────────
  const selectionRef = useRef<BatchSelection>(new BatchSelection(0));
  // Latest unified place-state, mirrored into refs so the bound-once renderer
  // tap callback can prevent staging BEFORE the click when placement is blocked
  // (Lot E: "prévenir avant le clic", never an after-the-fact surprise).
  const canPlaceNowRef = useRef(false);
  // Lot F (FEN-119): arming may be allowed even when posing is not (i.e. during
  // cooldown). Mirrored into a ref so the bound-once renderer tap callback can
  // let the user pre-aim their next cell while the gauge refills, instead of
  // refusing the tap the way a hard block (offline / frozen / banned) does.
  const canArmNowRef = useRef(false);
  // Live cooldown facts the bound-once tap callback needs (Lot F): are we cooling
  // right now, and how many seconds to the refill — so a "one cell already armed"
  // refusal reads as anticipation ("drops in Ns"), not the generic "gauge full".
  const onCooldownRef = useRef(false);
  const cooldownSecondsRef = useRef(0);
  const blockedMsgRef = useRef<MessageKey>("canvas.state.loading");
  const tierRef = useRef<TierClaim>(new TierClaim());
  const tierSourceRef = useRef<TierSource>(tierSource);
  tierSourceRef.current = tierSource;
  const restoreClaimFocusRef = useRef(false);
  // G4 (AC2): gauge-full sound — track previous full state via a ref so the
  // effect only fires when the gauge crosses the full threshold from below.
  const gaugeWasFullRef = useRef(false);
  // Arcade Gauge inputs (FEN-269): latch the cooling cycle length the first tick
  // it grows and reset when charges return — the ring drain is decorative (AC8).
  const ringTotalRef = useRef(0);
  // cooldownUntil already peeked — avoids spam
  const peekSentForRef = useRef<number>(0);

  // ─── Callbacks ──────────────────────────────────────────────────────────────

  const bumpTier = useCallback(() => setTierVersion((n) => n + 1), []);

  /** Push the staged batch + hovered cell to the renderer and re-render the HUD. */
  const syncOverlay = useCallback(() => {
    rendererRef.current?.setOverlay(selectionRef.current.entries(), hoverRef.current);
    setSelVersion((n) => n + 1);
  }, []);

  // Re-seat the batch cap from the optimistic effective charges (gauge charges +
  // claimed-but-unconfirmed overlay). Called after a claim so the ceiling
  // recomputes immediately (+1 usable charge → one more selectable cell).
  const refreshCap = useCallback(() => {
    const eff = tierRef.current.effectiveCharges(gauge?.charges ?? 0);
    // Lot F: while the gauge is empty the ceiling is one armed "next" cell, not
    // zero — so the batch isn't frozen during cooldown (it was, in Lot A/E).
    selectionRef.current.setCapacity(armingCapacity(eff, eff <= 0 && gauge !== null));
    setSelVersion((n) => n + 1);
  }, [gauge]);

  // Stage / toggle / recolor a cell with the current tool (the batch gesture).
  // `onlyAdd` = true skips the toggle-off path: re-clicking an already-staged
  // cell with the same colour is a no-op instead of removing it (FEN-1578
  // desktop left-click = select-only, never deselect).
  const stageCell = useCallback(
    (x: number, y: number, { onlyAdd = false }: { onlyAdd?: boolean } = {}) => {
      // First account-requiring interaction → consent (FEN-115 view-first wins on
      // the auth dimension: invite, don't block). For an anonymous viewer this
      // redirects to Twitch before any cell is staged.
      if (!requireAccount("stage-cell")) return;
      // Then prevent before the click for the *hard* blocked reasons (offline,
      // event window, ban): show the reason instead of staging a doomed cell
      // (Lot E — no "click to discover you can't"). Cooldown is NOT a hard block
      // here (Lot F): arming the next cell while the gauge refills is allowed, so
      // `canArmNowRef` (true during cooldown) gates instead of `canPlaceNowRef`.
      // Recoloring/deselecting an already-staged cell never grows the batch, so
      // let those through regardless.
      if (!canArmNowRef.current && !selectionRef.current.has(x, y)) {
        showToast({ kind: "rejected", messageKey: blockedMsgRef.current });
        return;
      }
      const c = erasingRef.current ? EMPTY_COLOR : colorRef.current;
      // Desktop left-click (onlyAdd): skip the toggle-off — re-clicking a staged
      // cell with the same colour leaves it staged rather than removing it.
      if (onlyAdd && selectionRef.current.colorAt(x, y) === c) return;
      const r = selectionRef.current.apply(x, y, c);
      if (r.kind === "cap") {
        // §5.5: gauge cap blocks silently.
      } else if (r.kind === "locked") {
        showToast({ kind: "banned", messageKey: "canvas.feedback.banned" });
      }
      syncOverlay();
    },
    [requireAccount, showToast, syncOverlay],
  );

  // Remove a staged cell (right-click deselect, FEN-1578). No-op when the cell
  // is not staged. Called by onRightTap (single click) and onRightHover (drag).
  const deselectCell = useCallback(
    (x: number, y: number) => {
      if (selectionRef.current.remove(x, y)) syncOverlay();
    },
    [syncOverlay],
  );

  // Commit the whole batch: one place{cid} per cell, reconciled per cid.
  const validate = useCallback(() => {
    // Defense in depth: a batch can only exist post-consent, but never commit
    // anonymously regardless of how the cells got staged.
    if (!requireAccount("validate")) return;
    const placement = placementRef.current;
    if (!placement) return;
    // Defensive: the button is disabled when blocked, but never commit a doomed
    // batch — surface the reason and keep the staged cells (Lot E + FEN-113).
    if (!canPlaceNowRef.current) {
      showToast({ kind: "rejected", messageKey: blockedMsgRef.current });
      return;
    }
    const cells = selectionRef.current.take();
    // §5.7/§7.5: enter processing state — spinner on button, count label stable.
    setSubmitting(true);
    setPlacedCount(cells.length);
    for (const cell of cells) {
      const msg = placement.place(cell.x, cell.y, cell.color);
      if (msg) netRef.current?.place(msg);
    }
    syncOverlay();
    // Brief processing flash, then exit mode (FEN-722).
    setTimeout(() => {
      setSubmitting(false);
      setDrawing(false);
    }, 300);
  }, [requireAccount, showToast, syncOverlay]);

  // "Poser ici" (FEN-338 / maquette): the dock's persistent primary CTA when no
  // batch is staged yet. It opens placement (enters draw mode) so the always-on
  // CTA in the maquette has a behaviour.
  const startPose = useCallback(() => {
    if (!requireAccount("enter-draw")) return;
    setDrawing(true);
    // FEN-797: ensure the bottom sheet is open so the palette is immediately visible.
    openPanel();
  }, [requireAccount, openPanel]);

  // Cancel: clear any staged cells, close the info panel, and exit draw mode
  // returning to VISIT state (S2 → S0 per FEN-797 spec §1).
  const cancel = useCallback(() => {
    selectionRef.current.clear();
    closeInspect();
    setDrawing(false);
    hoverRef.current = null;
    syncOverlay();
  }, [syncOverlay, closeInspect]);

  // Encash one pending tier: optimistic +1 (max + usable charge), celebrate, and
  // route the idempotent op to the server source.
  const claimNext = useCallback(() => {
    const op = tierRef.current.claimNext();
    if (!op) return;
    void tierSourceRef.current.claim(op);
    // Claiming the last pending tier unmounts the claim signal — anchor focus.
    if (tierRef.current.pending === 0) restoreClaimFocusRef.current = true;
    bumpTier();
    refreshCap();
  }, [bumpTier, refreshCap]);

  // "Tout encaisser": claim every stacked tier in one gesture.
  const claimAll = useCallback(() => {
    const ops = tierRef.current.claimAll();
    if (ops.length === 0) return;
    for (const op of ops) void tierSourceRef.current.claim(op);
    // "Tout encaisser" always empties the signal → its buttons unmount.
    restoreClaimFocusRef.current = true;
    bumpTier();
    refreshCap();
  }, [bumpTier, refreshCap]);

  // Replay any optimistically-encashed-but-unconfirmed tiers after a reconnect.
  // Stable (empty deps) because it closes over the ref containers (not their values).
  // The server applies each `tierIndex` at most once, so this is safe to repeat.
  const replayClaims = useCallback(() => {
    for (const op of tierRef.current.resendUnconfirmed()) void tierSourceRef.current.claim(op);
  }, []);

  // Subscribe to tier progression. Snapshots fold into the controller; a server
  // confirmation that advances the applied count shrinks the optimistic overlay.
  //
  // The subscription is keyed ONLY on the source identity (stable for the mount),
  // never on `refreshCap` — which changes on every gauge frame. Re-running it per
  // gauge frame would rebuild `tierRef` and drop the optimistic overlay before the
  // server `confirmed` caught up, flashing the réserve max down then back up. We
  // read the latest `refreshCap` through a ref so the overlay survives until the
  // matching `gauge` frame + fresh snapshot resorb it together (no visible jump).
  const refreshCapRef = useRef(refreshCap);
  refreshCapRef.current = refreshCap;

  // ─── Effects ────────────────────────────────────────────────────────────────

  // Intent resumption (FEN-580 / spec §5.3): after the OAuth return and Convex
  // confirms auth, read sessionStorage and restore draw mode + batch + cadrage.
  // Fires once per auth flip; cleared immediately so a page reload doesn't re-arm.
  useEffect(() => {
    if (!convexAuthed || !slug) return;
    const intent = loadReturnIntent(slug);
    if (intent) {
      clearReturnIntent(slug);
      // P1: restore view cadrage
      if (intent.scale != null && rendererRef.current) {
        rendererRef.current.setViewState(intent.scale, intent.tx ?? 0, intent.ty ?? 0);
      }
      // P1: re-enter draw mode
      setDrawing(true);
    }
    // P0: restore staged batch (regardless of intent, to honour E2 preservation)
    const cells = loadBatch(slug);
    if (cells.length > 0) {
      clearBatch(slug);
      for (const cell of cells) {
        selectionRef.current.apply(cell.x, cell.y, cell.color);
      }
      syncOverlay();
    }
  // syncOverlay is stable (empty deps); setDrawing is a stable setter.
  }, [convexAuthed, slug]);

  // Focus continuity after an encash (FEN-140 #1): once the claim signal has
  // emptied (its button unmounted), move focus to the placement button so it
  // never lands on <body>. Keyed on tierVersion so it runs after the claim re-render.
  useEffect(() => {
    if (restoreClaimFocusRef.current && tierRef.current.pending === 0) {
      restoreClaimFocusRef.current = false;
    }
  }, [tierVersion]);

  useEffect(() => {
    tierRef.current = new TierClaim();
    const unsub = tierSource.subscribe((p) => {
      tierRef.current.sync(p);
      bumpTier();
      refreshCapRef.current();
    });
    return unsub;
  }, [tierSource, bumpTier]);

  // Tick once a second while the gauge is empty so the countdown re-renders and
  // the re-peek fires at expiry. Continues past cooldownUntil until a server
  // `gauge` frame with charges ≥ 1 lands (prevents the stale-zero bug: FEN-409).
  useEffect(() => {
    if (gauge === null || gauge.charges > 0) return; // charges ≥ 1: button already active
    const id = setInterval(() => {
      setTick((n) => n + 1);
      const until = gauge.cooldownUntil;
      // Fire exactly one re-peek per expiry epoch (server's lazy refill may take
      // a moment); further ticks re-peek at focus/visibility (see listeners below).
      if (until > 0 && Date.now() >= until && peekSentForRef.current !== until) {
        peekSentForRef.current = until;
        netRef.current?.requestGaugePeek();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [gauge]);

  // The gauge ceiling drives the batch cap (k/N), including any claimed-but-
  // unconfirmed tier overlay so the ceiling reflects a just-encashed charge.
  useEffect(() => {
    const eff = tierRef.current.effectiveCharges(gauge?.charges ?? 0);
    selectionRef.current.setCapacity(armingCapacity(eff, eff <= 0 && gauge !== null));
    setSelVersion((n) => n + 1);
  }, [gauge]);

  // ─── Derived values ─────────────────────────────────────────────────────────

  // Lot D derived values (tierVersion forces the refresh). The réserve max/charges
  // grow by the optimistic overlay the instant a tier is encashed.
  void tierVersion;
  const tier = tierRef.current;
  const pendingTiers = tier.pending;
  const effectiveMax = gauge !== null ? tier.effectiveMax(gauge.max) : 0;
  const effectiveCharges = gauge !== null ? tier.effectiveCharges(gauge.charges) : 0;
  // Fold the optimistic tier overlay into the gauge the unified indicator reads
  // (Lot D × Lot E): a just-encashed réserve shows in the "ready" charge count
  // and lifts a 0-charge "cooldown" to "ready" before the confirming gauge frame.
  const effectiveGauge: GaugeState | null =
    gauge === null ? null : { ...gauge, charges: effectiveCharges, max: effectiveMax };

  // Cooldown engagement view (Lot F, FEN-119): from the SAME effective gauge the
  // unified indicator reads, plus the armed-batch size, recomputed each render
  // (the per-second tick keeps the countdown live).
  const cooldownView: CooldownView | null = effectiveGauge
    ? deriveCooldownView({
        charges: effectiveGauge.charges,
        cooldownUntil: effectiveGauge.cooldownUntil,
        now: Date.now(),
        staged: selectionRef.current.count,
      })
    : null;

  // G4 (AC2): gauge-full sound — one jingle per full TRANSITION, not on initial
  // load or per tick. Track previous full state via a ref so the effect only fires
  // when the gauge crosses the full threshold from below.
  const gaugeIsFull =
    effectiveGauge !== null &&
    effectiveGauge.max > 0 &&
    effectiveGauge.charges >= effectiveGauge.max;
  useEffect(() => {
    if (gaugeIsFull && !gaugeWasFullRef.current) playGaugeFullRef.current();
    gaugeWasFullRef.current = gaugeIsFull;
  }, [gaugeIsFull]);

  // Arcade Gauge inputs (FEN-269): the same effective gauge the indicator reads,
  // so a just-claimed réserve grows the bar instantly. Empty reserve ⇒ a draining
  // cooldown ring; otherwise a segmented k/N reserve. The ring drain is decorative
  // (AC8): GaugeState carries no regen interval, so latch the cooling cycle length
  // the first tick it grows and reset when charges return — the tnum seconds count
  // (kept by deriveCooldownView) is the real carrier of the remaining time.
  const effOnCooldown = effectiveGauge !== null && effectiveGauge.charges <= 0;
  const ringSeconds = cooldownView?.secondsUntilNext ?? 0;
  if (!effOnCooldown) ringTotalRef.current = 0;
  else if (ringSeconds > ringTotalRef.current) ringTotalRef.current = ringSeconds;
  const ringPercent = cooldownRingPercent(ringSeconds, ringTotalRef.current);

  const count = selectionRef.current.count; // re-read each render; selVersion forces the refresh
  void selVersion;

  return {
    // Shared refs — CanvasView wires these into renderer callbacks
    selectionRef,
    canPlaceNowRef,   // CanvasView writes after placeState
    canArmNowRef,     // CanvasView writes after placeState
    onCooldownRef,    // CanvasView writes after placeState
    cooldownSecondsRef, // CanvasView writes after placeState
    blockedMsgRef,    // CanvasView writes after placeState
    // Reactive state
    submitting,
    placedCount,
    count,
    // Tier/gauge derived
    pendingTiers,
    effectiveGauge,
    cooldownView,
    effOnCooldown,
    ringSeconds,
    ringPercent,
    // Callbacks
    stageCell,
    deselectCell,
    validate,
    startPose,
    cancel,
    claimNext,
    claimAll,
    syncOverlay,
    bumpTier,
    replayClaims,
  };
}
