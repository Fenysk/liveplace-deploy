/**
 * Live canvas client (FEN-65, batch-pose model FEN-113) — the interactive F3
 * surface wired to the F4 optimism/rollback controller over the FROZEN
 * `@canvas/protocol`.
 *
 * Pose model — "sélection multiple → validation" (FEN-113):
 *   - Desktop: hover frames a cell, a click stages it (toggle / recolor with the
 *     current tool); drag still pans, wheel zooms.
 *   - Mobile: the first tap reveals "Dessiner" (Draw); entering draw mode, taps
 *     stage cells, one-finger drag pans, two-finger pinch zooms (renderer.ts).
 *   - The staged batch ({@link BatchSelection}) is capped at the available gauge
 *     (k/N) and supports multi-colour + eraser per cell. "Valider" commits the
 *     whole batch in one action; "Annuler" clears it.
 *   - Commit reuses the per-`cid` reconciliation in {@link OptimisticPlacement}:
 *     one `place{cid}` per cell, so a partial server refusal rolls back only the
 *     rejected cells (the rest stay). The express 1-cell path is tap → Valider.
 *
 * Every user string flows through `@canvas/i18n` so the UI is FR/EN in place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";
import type { GaugeState } from "@canvas/protocol";
import { AuthButton } from "../../auth/AuthButton.js";
import { authClient, signInWithTwitch } from "../../auth/auth-client.js";
import { LanguageSwitcher } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { OptimisticPlacement, type PlacementFeedback } from "./placement.js";
import { BatchSelection, EMPTY_COLOR } from "./selection.js";
import { OnboardingCoach, createLocalOnboardingStorage, type OnboardingHint } from "./onboarding.js";
import { gateInteraction, type CanvasInteraction } from "./authGate.js";
import { TierClaim, inertTierSource, type TierSource } from "./tierClaim.js";
import { gatewayWsUrl } from "./gateway.js";
import "./canvas.css";

const DEFAULT_COLOR = 5; // red — a visible default pose colour
const TOAST_MS = 2600;
const IDLE_MS = 7000; // hesitation: inactive a few seconds ⇒ offer help (ux-spec §D9)

interface ToastState {
  kind: PlacementFeedback["kind"] | "cap" | "placed";
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface CanvasViewProps {
  /** Canvas slug; null targets the default canvas (`/ws`). */
  slug?: string | null;
  /**
   * Tier-progression source for the "claim de palier" mechanic (Lot D). Defaults
   * to {@link inertTierSource} so the claim UI stays hidden until the backend
   * reframe (`getMyTierProgress`/`claimTier`) is wired — see tierClaim.ts.
   */
  tierSource?: TierSource;
}

export function CanvasView({ slug = null, tierSource = inertTierSource }: CanvasViewProps): React.ReactElement {
  const t = useTranslate();
  // The renderer's keyboard hooks are bound once; read the latest translator
  // through a ref so a mid-session locale switch keeps announcements localized
  // without tearing down the renderer.
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const netRef = useRef<CanvasNetClient | null>(null);
  const placementRef = useRef<OptimisticPlacement | null>(null);
  const selectionRef = useRef<BatchSelection>(new BatchSelection(0));
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  // current tool, mirrored into refs so the renderer's tap callback (bound once)
  // always reads the latest value without re-binding.
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [erasing, setErasing] = useState(false);
  const colorRef = useRef(color);
  const erasingRef = useRef(erasing);
  colorRef.current = color;
  erasingRef.current = erasing;

  // Mobile gate: the first touch reveals "Dessiner"; desktop selects directly.
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const [armed, setArmed] = useState<{ x: number; y: number } | null>(null);
  // True when a cell is smaller than the touch target — nudge to zoom in (U5).
  const [belowTarget, setBelowTarget] = useState(false);

  // View-first auth (FEN-115): anonymous viewers watch/zoom/pick-colour freely;
  // the FIRST account-requiring interaction (enter draw mode / stage the first
  // cell, not only the commit) triggers the quasi-instant Twitch consent and
  // returns to this same canvas. Mirrored into a ref so the renderer's tap
  // callback (bound once) always reads the live session.
  const { data: session } = authClient.useSession();
  const authedRef = useRef(false);
  authedRef.current = session != null;

  const [gauge, setGauge] = useState<GaugeState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [viewers, setViewers] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [announce, setAnnounce] = useState(""); // polite SR readout of the keyboard cursor (U3)
  const [selVersion, setSelVersion] = useState(0); // bumped on every batch change
  const [, setTick] = useState(0); // drives the per-second cooldown countdown

  // Lot D — "claim de palier": one controller per mount; `pending` drives the
  // (non-blocking, persistent, stackable) claim signal; `tierVersion` forces a
  // HUD refresh whenever progression or the optimistic overlay changes.
  const tierRef = useRef<TierClaim>(new TierClaim());
  const tierSourceRef = useRef<TierSource>(tierSource);
  tierSourceRef.current = tierSource;
  const [tierVersion, setTierVersion] = useState(0);
  const [celebrate, setCelebrate] = useState(false);
  const bumpTier = useCallback(() => setTierVersion((n) => n + 1), []);
  // Focus continuity for the encash gesture (FEN-140 #1): when a claim empties
  // the signal, its focused button unmounts and focus would fall to <body>. We
  // move focus to the (always-mounted) gauge — the réserve that just grew — so
  // keyboard/SR users keep their place right after the dopamine moment.
  const gaugeRef = useRef<HTMLParagraphElement>(null);
  const restoreClaimFocusRef = useRef(false);

  // Adaptive just-in-time onboarding (FEN-118): a behaviour-driven coach decides
  // which (non-blocking) contextual hint to surface at each funnel step. Implicit
  // profile detection short-circuits the basics for connaisseurs; "seen" persists.
  const coachRef = useRef<OnboardingCoach | null>(null);
  if (coachRef.current === null) {
    coachRef.current = new OnboardingCoach({ storage: createLocalOnboardingStorage() });
  }
  const [hint, setHint] = useState<OnboardingHint | null>(null);
  const aimedRef = useRef(false); // emit the "aim" funnel event only once
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emit = useCallback((event: Parameters<OnboardingCoach["send"]>[0]) => {
    setHint(coachRef.current!.send(event));
  }, []);

  // Reset the hesitation clock on every meaningful interaction; firing it offers
  // discreet help (never modal). Connaisseurs are filtered out inside the coach.
  const bumpActivity = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => emit({ type: "idle" }), IDLE_MS);
  }, [emit]);

  /** Push the staged batch + hovered cell to the renderer and re-render the HUD. */
  const syncOverlay = useCallback(() => {
    rendererRef.current?.setOverlay(selectionRef.current.entries(), hoverRef.current);
    setSelVersion((n) => n + 1);
  }, []);

  const showToast = useCallback((f: ToastState) => {
    setToast({ kind: f.kind, messageKey: f.messageKey, params: f.params });
  }, []);

  // Gate an account-requiring interaction (FEN-115). Anonymous viewers are sent
  // to the quasi-instant Twitch consent with a callback back to THIS canvas;
  // returns false so the caller stops (the redirect takes over). Cancelling at
  // Twitch is non-punitive — the viewer simply returns here in read-only mode.
  const requireAccount = useCallback(
    (interaction: CanvasInteraction): boolean => {
      const decision = gateInteraction(interaction, authedRef.current, {
        slug,
        currentPath: typeof window !== "undefined" ? window.location.pathname : "/",
      });
      if (decision.kind === "consent") {
        void signInWithTwitch(decision.callbackURL);
        return false;
      }
      return true;
    },
    [slug],
  );

  // Stage / toggle / recolor a cell with the current tool (the batch gesture).
  const stageCell = useCallback(
    (x: number, y: number) => {
      // First account-requiring interaction → consent (not only at commit).
      if (!requireAccount("stage-cell")) return;
      const c = erasingRef.current ? EMPTY_COLOR : colorRef.current;
      const r = selectionRef.current.apply(x, y, c);
      bumpActivity();
      if (r.kind === "cap") {
        showToast({ kind: "cap", messageKey: "canvas.feedback.capReached", params: { max: r.cap } });
        emit({ type: "blocked-attempt" }); // hit a wall ⇒ offer help (ux-spec §D9)
      } else if (r.kind === "locked") {
        showToast({ kind: "banned", messageKey: "canvas.feedback.banned" });
        emit({ type: "blocked-attempt" });
      } else {
        emit({ type: "stage" }); // a productive action graduates the basic hints
      }
      syncOverlay();
    },
    [requireAccount, showToast, syncOverlay, emit, bumpActivity],
  );

  // Commit the whole batch: one place{cid} per cell, reconciled per cid.
  const validate = useCallback(() => {
    // Defense in depth: a batch can only exist post-consent, but never commit
    // anonymously regardless of how the cells got staged.
    if (!requireAccount("validate")) return;
    const placement = placementRef.current;
    if (!placement) return;
    const cells = selectionRef.current.take();
    for (const cell of cells) {
      const msg = placement.place(cell.x, cell.y, cell.color);
      if (msg) netRef.current?.place(msg);
    }
    // Light positive acknowledgement of the commit (Peak-End, U7). A batch that
    // contains any erase didn't only "place" pixels — say "mis à jour / updated"
    // so an all-erase (or mixed) commit isn't mislabelled as posed (FEN-124 U7
    // residual, UX-accepted copy reco).
    if (cells.length > 0) {
      const hasErase = cells.some((c) => c.color === EMPTY_COLOR);
      showToast({
        kind: "placed",
        messageKey: hasErase ? "canvas.feedback.updated" : "canvas.feedback.placed",
        params: { count: cells.length },
      });
      // The pixel lands optimistically right now — that's the "aha" moment.
      emit({ type: "commit" });
      emit({ type: "placed" });
    }
    bumpActivity();
    setArmed(null);
    syncOverlay();
  }, [requireAccount, showToast, syncOverlay, emit, bumpActivity]);

  // Express single-pixel path (U1): stage the armed cell AND commit in one tap,
  // so the first mobile pixel is 2 gestures (tap → "Poser ici"). Keeps the batch
  // "Dessiner" path intact for multi-cell construction. Account-gated up front
  // (FEN-115): an express pose is itself a staging interaction, so an anonymous
  // viewer is sent to Twitch consent before anything is staged.
  const placeHere = useCallback(
    (x: number, y: number) => {
      if (!requireAccount("stage-cell")) return;
      const c = erasingRef.current ? EMPTY_COLOR : colorRef.current;
      const r = selectionRef.current.apply(x, y, c);
      if (r.kind === "cap") {
        showToast({ kind: "cap", messageKey: "canvas.feedback.capReached", params: { max: r.cap } });
        setArmed(null);
        syncOverlay();
        return;
      }
      if (r.kind === "locked") {
        showToast({ kind: "banned", messageKey: "canvas.feedback.banned" });
        setArmed(null);
        syncOverlay();
        return;
      }
      validate(); // commits the just-staged single cell and clears `armed`
    },
    [requireAccount, showToast, syncOverlay, validate],
  );

  // Annuler: empty the batch and leave draw mode.
  const cancel = useCallback(() => {
    selectionRef.current.clear();
    setArmed(null);
    setDrawing(false);
    syncOverlay();
  }, [syncOverlay]);

  // Re-seat the batch cap from the optimistic effective charges (gauge charges +
  // claimed-but-unconfirmed overlay). Called after a claim so the ceiling
  // recomputes immediately (+1 usable charge → one more selectable cell).
  const refreshCap = useCallback(() => {
    selectionRef.current.setCapacity(tierRef.current.effectiveCharges(gauge?.charges ?? 0));
    setSelVersion((n) => n + 1);
  }, [gauge]);

  // Encash one pending tier: optimistic +1 (max + usable charge), celebrate, and
  // route the idempotent op to the server source.
  const claimNext = useCallback(() => {
    const op = tierRef.current.claimNext();
    if (!op) return;
    void tierSourceRef.current.claim(op);
    // Claiming the last pending tier unmounts the claim signal — anchor focus.
    if (tierRef.current.pending === 0) restoreClaimFocusRef.current = true;
    setCelebrate(true);
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
    setCelebrate(true);
    bumpTier();
    refreshCap();
  }, [bumpTier, refreshCap]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  // Auto-dismiss the claim celebration.
  useEffect(() => {
    if (!celebrate) return;
    const id = setTimeout(() => setCelebrate(false), TOAST_MS);
    return () => clearTimeout(id);
  }, [celebrate]);

  // Focus continuity after an encash (FEN-140 #1): once the claim signal has
  // emptied (its button unmounted), move focus to the gauge so it never lands
  // on <body>. Keyed on tierVersion so it runs after the claim re-render.
  useEffect(() => {
    if (restoreClaimFocusRef.current && tierRef.current.pending === 0) {
      restoreClaimFocusRef.current = false;
      gaugeRef.current?.focus();
    }
  }, [tierVersion]);

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
  useEffect(() => {
    tierRef.current = new TierClaim();
    const unsub = tierSource.subscribe((p) => {
      tierRef.current.sync(p);
      bumpTier();
      refreshCapRef.current();
    });
    return unsub;
  }, [tierSource, bumpTier]);

  // Tick once a second while on cooldown so the countdown re-renders.
  useEffect(() => {
    const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
    if (!onCooldown) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [gauge]);

  // The gauge ceiling drives the batch cap (k/N), including any claimed-but-
  // unconfirmed tier overlay so the ceiling reflects a just-encashed charge.
  useEffect(() => {
    selectionRef.current.setCapacity(tierRef.current.effectiveCharges(gauge?.charges ?? 0));
    setSelVersion((n) => n + 1);
  }, [gauge]);

  // Mount: build renderer + net client, connect. Teardown on unmount.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const renderer = new CanvasRenderer(
      el,
      {
        onTap: (x, y, pointerType) => {
          // Desktop (mouse/pen) or already in draw mode → stage directly.
          if (pointerType === "mouse" || pointerType === "pen" || drawingRef.current) {
            stageCell(x, y);
            return;
          }
          // Mobile first touch → reveal "Dessiner" for this cell (no accidental pose).
          // The reveal is the mobile "visée" — the funnel's first-aim moment.
          if (!aimedRef.current) {
            aimedRef.current = true;
            emit({ type: "aim" });
          }
          bumpActivity();
          setArmed({ x, y });
        },
        onHover: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
          // Desktop "visée": surface the "how" hint the first time the cursor
          // frames a cell (the coach de-dups / suppresses for connaisseurs).
          if (cell && !aimedRef.current) {
            aimedRef.current = true;
            emit({ type: "aim" });
          }
          if (cell) bumpActivity();
        },
        onScaleClass: setBelowTarget,
        // Keyboard roving cursor (FEN-123): same stage/validate/cancel gestures
        // as the pointer (true 3-modality parity) + a polite SR announce of the
        // targeted cell and whether it's already staged.
        onCursorMove: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
          const staged = selectionRef.current.has(cell.x, cell.y);
          setAnnounce(tRef.current(staged ? "canvas.cursorAtStaged" : "canvas.cursorAt", cell));
        },
        onActivate: (x, y) => stageCell(x, y),
        onCancel: () => cancel(),
        onValidate: () => validate(),
      },
      { interactive: true },
    );
    rendererRef.current = renderer;

    const net = new CanvasNetClient({
      url: gatewayWsUrl(slug),
      handlers: {
        onWelcome: (w) => {
          if (!placementRef.current) {
            placementRef.current = new OptimisticPlacement({
              width: w.width,
              height: w.height,
              paletteSize: renderer.paletteSize,
              surface: renderer,
              onGauge: setGauge,
              onFeedback: (f) => {
                if (f.kind === "banned") selectionRef.current.setLocked(true);
                showToast(f);
              },
            });
          }
        },
        onBinary: (buf) => {
          const seq = renderer.applyBinary(buf);
          placementRef.current?.repaintPending();
          return seq;
        },
        onPlacementFrame: (msg) => placementRef.current?.handle(msg),
        onViewerCount: setViewers,
        onReconnected: () => {
          const q = placementRef.current?.resendQueue() ?? [];
          for (const m of q) netRef.current?.place(m);
          // Replay any optimistically-encashed-but-unconfirmed tiers. The server
          // applies each `tierIndex` at most once, so this is safe to repeat.
          for (const op of tierRef.current.resendUnconfirmed()) void tierSourceRef.current.claim(op);
        },
        onStatus: setStatus,
      },
    });
    netRef.current = net;
    void net.connect();

    return () => {
      net.disconnect();
      renderer.destroy();
      rendererRef.current = null;
      netRef.current = null;
      placementRef.current = null;
    };
  }, [slug, showToast, stageCell, validate, cancel, emit, bumpActivity]);

  const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
  const cooldownSeconds = onCooldown ? Math.max(0, Math.ceil((gauge!.cooldownUntil - Date.now()) / 1000)) : 0;

  // Onboarding: arrival nudge + start the hesitation clock, once per mount.
  useEffect(() => {
    emit({ type: "arrive" });
    bumpActivity();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [emit, bumpActivity]);

  // Auto-hide a transient hint (arrival / milestones) after its delay.
  useEffect(() => {
    if (!hint || hint.autoHideMs == null) return;
    const id = setTimeout(() => {
      coachRef.current?.clearActive();
      setHint(null);
    }, hint.autoHideMs);
    return () => clearTimeout(id);
  }, [hint]);

  // First empty gauge: turn the wait into anticipation (just-in-time, before the
  // viewer is surprised by it). Fires on the transition into cooldown.
  const wasCooldownRef = useRef(false);
  useEffect(() => {
    if (onCooldown && !wasCooldownRef.current) {
      emit({ type: "gauge-empty", params: { seconds: cooldownSeconds } });
    }
    wasCooldownRef.current = onCooldown;
  }, [onCooldown, cooldownSeconds, emit]);

  // First reserve growth (Lot D claim / points threshold): show the causality once.
  const prevMaxRef = useRef<number | null>(null);
  useEffect(() => {
    const max = gauge?.max ?? null;
    if (max != null && prevMaxRef.current != null && max > prevMaxRef.current) {
      emit({ type: "gauge-grew", params: { max } });
    }
    if (max != null) prevMaxRef.current = max;
  }, [gauge, emit]);

  const sel = selectionRef.current;
  const count = sel.count; // re-read each render; selVersion forces the refresh
  void selVersion;

  // Lot D derived values (tierVersion forces the refresh). The réserve max grows
  // by the optimistic overlay the instant a tier is encashed.
  void tierVersion;
  const tier = tierRef.current;
  const pendingTiers = tier.pending;
  const effectiveMax = gauge !== null ? tier.effectiveMax(gauge.max) : 0;
  // Current charges incl. the optimistic +1-per-claim grant, so a just-encashed
  // réserve visibly grows (5/5 → 6/6) before the confirming gauge frame lands.
  const effectiveCharges = gauge !== null ? tier.effectiveCharges(gauge.charges) : 0;

  return (
    <div className="lp-app">
      {/* Focusable interactive grid: role="application" so a screen reader passes
          arrow keys straight to the roving cursor instead of its browse mode.
          Named + described for the text alternative (U3). */}
      <canvas
        ref={canvasRef}
        className="lp-canvas"
        tabIndex={0}
        role="application"
        aria-label={t("canvas.canvasLabel")}
        aria-describedby="lp-canvas-help"
      />
      <p id="lp-canvas-help" className="lp-sr-only">
        {t("canvas.keyboardHelp")}
      </p>
      {/* Polite readout of the keyboard cursor cell (and whether it's staged). */}
      <p className="lp-sr-only" aria-live="polite">
        {announce}
      </p>

      <div className="lp-topbar">
        {viewers !== null && <span className="lp-pill">{t("canvas.viewers", { count: viewers })}</span>}
        {status !== "open" && (
          <span className="lp-pill">{t(status === "connecting" ? "canvas.connecting" : "canvas.offline")}</span>
        )}
        {/* canvas → gallery: a light escape hatch so the hero isn't an island (FEN-114). */}
        <Link to={paths.gallery()} className="lp-navlink">
          {t("nav.gallery")}
        </Link>
        {/* "Comment ça marche" stays available (rang 3) so a connaisseur can
            re-read the core gesture on demand — never blocking (FEN-118). */}
        <button
          type="button"
          className="lp-navlink lp-howto"
          onClick={() => setHint(coachRef.current!.recall())}
        >
          {t("canvas.onboarding.howto")}
        </button>
        <AuthButton />
        <LanguageSwitcher />
      </div>

      {/* Adaptive onboarding hint — at most one, non-blocking, dismissible when
          it is a help/recall prompt (FEN-118). */}
      {hint && (
        <div className={`lp-onboard lp-onboard--${hint.step}`} role="status">
          <span className="lp-onboard-text">{t(hint.messageKey, hint.params)}</span>
          {hint.dismissible && (
            <button
              type="button"
              className="lp-onboard-dismiss"
              aria-label={t("canvas.onboarding.dismiss")}
              onClick={() => emit({ type: "dismiss" })}
            >
              {t("canvas.onboarding.dismiss")}
            </button>
          )}
        </div>
      )}

      <div className="lp-hud">
        <h1>{t("app.title")}</h1>

        <p
          ref={gaugeRef}
          tabIndex={-1}
          className={`lp-gauge${onCooldown ? " is-empty" : ""}`}
          aria-live="polite"
        >
          {gauge === null
            ? t("canvas.connecting")
            : onCooldown
              ? t("canvas.cooldown", { seconds: cooldownSeconds })
              : count > 0
                ? t("canvas.batchCount", { count, max: sel.capacity })
                : t("canvas.gauge", { current: effectiveCharges, max: effectiveMax })}
        </p>

        {/* Lot D — claim signal: non-blocking, persistent, stackable. The viewer
            encashes a tier earned by playing; nothing else (no points/shop). */}
        {pendingTiers > 0 && (
          // No live role here (FEN-140 #2): the claim signal is a standing
          // affordance, not an alert, so it must not re-announce on every
          // `pending` decrement. The celebration is the single claim announcement.
          <div className="lp-claim">
            <span className="lp-claim-label">
              {pendingTiers > 1
                ? t("canvas.claim.stacked", { count: pendingTiers })
                : t("canvas.claim.available")}
            </span>
            {/* Primary claims ONE tier — when stacked, signal the "+1" so it reads
                as one-by-one vs. "tout encaisser" all-at-once (FEN-140 #4). */}
            <button type="button" className="lp-btn is-primary lp-claim-btn" onClick={claimNext}>
              {pendingTiers > 1 ? t("canvas.claim.actionOne") : t("canvas.claim.action")}
            </button>
            {pendingTiers > 1 && (
              <button type="button" className="lp-btn lp-claim-all" onClick={claimAll}>
                {t("canvas.claim.all", { count: pendingTiers })}
              </button>
            )}
          </div>
        )}

        <div className="lp-palette" role="group" aria-label={t("canvas.palette")}>
          {PALETTE_HEX.map((hex, i) => (
            <button
              key={i}
              type="button"
              className="lp-swatch"
              style={{ background: hex }}
              aria-label={hex}
              aria-pressed={!erasing && color === i}
              onClick={() => {
                setColor(i);
                setErasing(false);
              }}
            />
          ))}
        </div>

        <div className="lp-tools">
          <button type="button" className="lp-btn" aria-pressed={erasing} onClick={() => setErasing((e) => !e)}>
            {t("canvas.erase")}
          </button>

          {/* Mobile gate on the armed cell: express single pose ("Poser ici", 2
              gestures — U1) OR enter batch draw mode to build a multi-cell set. */}
          {armed && !drawing && (
            <>
              <button type="button" className="lp-btn is-primary" onClick={() => placeHere(armed.x, armed.y)}>
                {t("canvas.placeHere")}
              </button>
              <button
                type="button"
                className="lp-btn"
                onClick={() => {
                  // Entering draw mode is itself an account-requiring interaction
                  // (FEN-115): gate before staging so the redirect fires early.
                  if (!requireAccount("enter-draw")) return;
                  setDrawing(true);
                  stageCell(armed.x, armed.y);
                  setArmed(null);
                }}
              >
                {t("canvas.draw")}
              </button>
            </>
          )}

          {/* Valider appears once the batch is non-empty. */}
          {count > 0 && (
            <button type="button" className="lp-btn is-primary" disabled={sel.isLocked} onClick={validate}>
              {t("canvas.validate", { count })}
            </button>
          )}

          {/* Always-visible exit while building or in draw mode (U4): "Annuler"
              with a pending batch, "Terminer" when empty so there is always a
              way out of draw mode. */}
          {(count > 0 || drawing) && (
            <button type="button" className="lp-btn" onClick={cancel}>
              {count > 0 ? t("canvas.cancel") : t("canvas.finish")}
            </button>
          )}
        </div>

        {/* Mode indicator: draw mode persists across commits on mobile (U4). */}
        {drawing && (
          <p className="lp-mode" role="status">
            {t("canvas.drawingMode")}
          </p>
        )}

        {/* Low-zoom nudge while there is intent to pose (Fitts, U5). */}
        {belowTarget && (drawing || armed !== null || count > 0) && (
          <p className="lp-hint lp-hint--zoom" role="status">
            {t("canvas.zoomHint")}
          </p>
        )}
        {count === 0 && !armed && <p className="lp-hint">{t("canvas.batchHint")}</p>}
      </div>

      {toast && (
        <div
          className={`lp-toast${
            toast.kind === "placed" ? " is-success" : toast.kind === "cooldown" ? " is-cooldown" : ""
          }`}
          role="status"
        >
          {t(toast.messageKey as MessageKey, toast.params)}
        </div>
      )}

      {/* Claim celebration — the dopamine moment when a tier is encashed. */}
      {celebrate && (
        <div className="lp-celebrate" role="status">
          {t("canvas.claim.celebrate", { max: effectiveMax })}
        </div>
      )}
    </div>
  );
}
