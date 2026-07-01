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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";
import type { GaugeState } from "@canvas/protocol";
import { AuthButton } from "../../auth/AuthButton.js";
import { AuthModal } from "../../auth/AuthModal.js";
import { authClient, signInWithTwitch } from "../../auth/auth-client.js";
import {
  saveBatch,
  loadBatch,
  clearBatch,
  saveReturnIntent,
  loadReturnIntent,
  clearReturnIntent,
} from "../../auth/return-trip.js";
import { sanitizeReturnTo } from "../../auth/returnTo.js";
import { LanguageSwitcher } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { ShareButton } from "./ShareButton.js";
import { StudioPanel } from "../streamer/StudioPanel.js";
import { StudioDashboardBody } from "../streamer/StudioDashboardBody.js";
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { OptimisticPlacement, type PlacementFeedback } from "./placement.js";
import { BatchSelection, EMPTY_COLOR } from "./selection.js";
import { gateInteraction, canvasCallbackURL, type CanvasInteraction } from "./authGate.js";
import { TierClaim, inertTierSource, type TierSource } from "./tierClaim.js";
import { derivePlaceState, resolvePermission, type CanPlaceReason, type ConnectionState } from "./placeState.js";
import { deriveCooldownView, armingCapacity } from "./cooldown.js";
import { deriveModerationNotice, type CanvasLiveness } from "./moderationNotice.js";
import {
  derivePixelInfo,
  inertPixelAuthorSource,
  type PixelOccupancy,
  type PixelAuthorSource,
} from "./pixelInfo.js";
import { inertModerationSource, type ModerationSource } from "./moderationSource.js";
import { gatewayWsUrl } from "./gateway.js";
import {
  OnboardingCoach,
  createLocalOnboardingStorage,
  isModelLearned,
  type OnboardingHint,
} from "./onboarding.js";
import {
  GuidedOnboardingController,
  createLocalWelcomeStorage,
  type GateState,
} from "./guidedOnboarding.js";
// Arcade design system (Lot 0 — FEN-268): one definition per component, token-
// only styling. This screen is a COMPOSITION of these, never a local restyle.
import {
  BottomSheet,
  Button,
  ColorSelector,
  HeroGauge,
  Toast,
  TwitchGlyph,
  Wordmark,
  StateScreen,
  StateArt,
  OfflineBanner,
  type EraserItem,
  type PaletteColor,
} from "../../ui/index.js";
import { FrescoCanvas } from "./FrescoCanvas.js";
import { computeShowHandle } from "./panelHandle.js";
import { useSoundEngine } from "./useSoundEngine.js";
import { SoundToggle } from "./SoundToggle.js";
import "./canvas.css";

const DEFAULT_COLOR = 5; // red — a visible default pose colour
const ERASER_ID = "__eraser__"; // sentinel id for the palette eraser item (FEN-418 A7)
const TOAST_MS = 2600;

/**
 * Convex queries referenced by name (`module:function`) — decoupled from the
 * generated api, the same pattern GalleryPage uses. They feed the unified
 * "puis-je poser ?" indicator (Lot E, [FEN-117]):
 *   - `getCanvasBySlug` → the canvas doc (status + event window) and its id
 *   - `canPlace` → the placement permission contract `{ allowed, reason? }`
 * Both are skipped (no network) when there is no slug to resolve.
 */
const getCanvasBySlugRef = makeFunctionReference<
  "query",
  { slug: string },
  { _id: string; status: string; eventStartAt: number | null; eventEndAt: number | null } | null
>("canvases:getCanvasBySlug");

const canPlaceRef = makeFunctionReference<
  "query",
  { canvasId: string },
  { allowed: boolean; reason?: CanPlaceReason }
>("canvases:canPlace");

/** Map the WS transport status onto the state machine's connection vocabulary. */
function toConnectionState(status: ConnectionStatus): ConnectionState {
  return status === "open" ? "open" : status === "connecting" ? "connecting" : "offline";
}

interface ToastState {
  // "placed" = batch-commit confirmation (FEN-755); "success" = positive
  // mod-action confirmation (FEN-754); the placement feedback kinds + "cap" cover
  // the pose path.
  kind: PlacementFeedback["kind"] | "cap" | "placed" | "success";
  messageKey: string;
  params?: Record<string, string | number>;
}

/** The three pixel-click moderation actions (FEN-754 §8.2: S8.3 / S8.4 / S8.5). */
type ModAction = "deletePixel" | "deleteGroup" | "ban";

export interface CanvasViewProps {
  /** Canvas slug; null targets the default canvas (`/ws`). */
  slug?: string | null;
  /**
   * Tier-progression source for the "claim de palier" mechanic (Lot D). Defaults
   * to {@link inertTierSource} so the claim UI stays hidden until the backend
   * reframe (`getMyTierProgress`/`claimTier`) is wired — see tierClaim.ts.
   */
  tierSource?: TierSource;
  /**
   * Per-cell author source for the pixel-info panel (FEN-249). Defaults to
   * {@link inertPixelAuthorSource} (resolves to `null` → "author unavailable")
   * until the viewer-facing backend attribution query lands — see pixelInfo.ts
   * and the FEN-249 backend dependency.
   */
  pixelAuthorSource?: PixelAuthorSource;
  /**
   * Whether the CURRENT viewer may moderate this canvas (FEN-754 §8.2). Drives
   * whether the pixel-info panel exposes the three inline mod actions. Defaults to
   * `false` (no mod UI); {@link CanvasViewLive} feeds the live `moderation.canModerate`.
   */
  canModerate?: boolean;
  /**
   * Source for the three pixel-click moderation actions (FEN-754 §8.2: delete
   * pixel / erase group / ban author). Defaults to {@link inertModerationSource};
   * {@link CanvasViewLive} injects the live Convex bridge. Only ever exercised when
   * `canModerate` is true (the actions are mod-authorised server-side regardless).
   */
  moderationSource?: ModerationSource;
  /**
   * Resolve the Convex JWT for the canvas socket, appended as `?token=` so the
   * gateway resolves `userId` and serves the per-user `gauge` that ungates
   * placement (FEN-184). CanvasView stays Convex-agnostic — {@link CanvasViewLive}
   * injects the real resolver (`makeWsTicketResolver`). Defaults to anonymous
   * read-only. Regression guard: FEN-267 was this wiring going missing, so every
   * socket connected anonymously (no gauge ⇒ stuck "loading", cannot place).
   */
  fetchTicket?: () => Promise<string | null>;
  /**
   * Convex's CONFIRMED auth state. The mount effect connects the socket once
   * (anonymously on the post-OAuth landing, before the JWT resolves); when this
   * flips the socket reconnects so `fetchTicket` re-runs and carries the token
   * (FEN-184). Injected by {@link CanvasViewLive}; defaults to anonymous.
   */
  convexAuthed?: boolean;
  /**
   * True while Convex auth is still resolving for a browser that "was authed"
   * (FEN-957). Suppresses the dock Twitch CTA during the loading window so it
   * does not flash and then disappear once the session confirms. Injected by
   * {@link CanvasViewLive} via `isLoading` from `useConvexAuth` + the localStorage
   * hint; defaults to `false` (no suppression).
   */
  authPending?: boolean;
  /**
   * True SSI le viewer courant est l'owner STRICT du canvas (FEN-1174 / S0).
   * Gates l'item « Studio / Piloter » dans le burger (AC3.6) et le montage
   * de `<StudioPanel>`. Un viewer ou un mod non-owner voit `false` (défaut).
   * Injecté par {@link CanvasViewLive} via `moderation:amOwner`.
   */
  isCanvasOwner?: boolean;
}

/** Default ticket resolver: anonymous read-only (keeps CanvasView Convex-free). */
const anonymousTicket = (): Promise<string | null> => Promise.resolve(null);

export function CanvasView({
  slug = null,
  tierSource = inertTierSource,
  pixelAuthorSource = inertPixelAuthorSource,
  canModerate = false,
  moderationSource = inertModerationSource,
  fetchTicket = anonymousTicket,
  convexAuthed = false,
  authPending = false,
  isCanvasOwner = false,
}: CanvasViewProps): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  // The renderer's keyboard hooks are bound once; read the latest translator
  // through a ref so a mid-session locale switch keeps announcements localized
  // without tearing down the renderer.
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const netRef = useRef<CanvasNetClient | null>(null);
  // FEN-569: tracks whether the initial net.connect() has been called for the
  // current net instance. Reset on mount-effect cleanup so slug re-mounts start
  // fresh. Used to distinguish a deferred first-connect from a reconnect.
  const wsConnectedRef = useRef(false);
  // The net client binds `fetchTicket` once at construction; read it through a
  // ref so a later resolver (or the live auth it closes over) is always honoured
  // when the socket (re)connects — see the auth-flip reconnect effect below.
  const fetchTicketRef = useRef(fetchTicket);
  fetchTicketRef.current = fetchTicket;
  const placementRef = useRef<OptimisticPlacement | null>(null);
  const selectionRef = useRef<BatchSelection>(new BatchSelection(0));
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
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

  // current tool, mirrored into refs so the renderer's tap callback (bound once)
  // always reads the latest value without re-binding.
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [erasing, setErasing] = useState(false);
  const colorRef = useRef(color);
  const erasingRef = useRef(erasing);
  colorRef.current = color;
  erasingRef.current = erasing;

  // The pose palette for the Arcade ColorSelector (FEN-268): each swatch fill is
  // the EXACT frozen-protocol palette hex (no tint/opacity) so the selected
  // colour == the posed pixel (fidelity). The accessible label is a localized
  // "Couleur N" so selection reads in B&W / for colour-blind users (never colour
  // alone). Memoized on the translator so a locale switch relabels in place.
  const palette = useMemo<PaletteColor[]>(
    () => PALETTE_HEX.map((hex, i) => ({ id: String(i), hex, label: t("canvas.color", { index: i + 1 }) })),
    [t],
  );
  // Eraser palette item (FEN-418 A7): index 0, icon + label, auto-width.
  // Memoized on translator for locale switch support.
  const eraserItem = useMemo<EraserItem>(() => ({ id: ERASER_ID, label: t("canvas.erase") }), [t]);

  // Selection ("draw") mode. Refonte FEN-249: a click no longer selects — it
  // opens the pixel-info panel; selection starts only via "Dessiner".
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  // §5.7/§7.5: brief processing state while the batch is in-flight.
  const [submitting, setSubmitting] = useState(false);
  // Stores the committed count for the button label during the submitting flash.
  const [placedCount, setPlacedCount] = useState(0);
  // Pixel-info panel (FEN-249): the cell a click is currently inspecting (coords
  // + author), null when closed. Opening it never stages a cell.
  const [inspect, setInspect] = useState<{ x: number; y: number } | null>(null);
  // Resolved occupancy of the inspected cell: `undefined` while the lookup is in
  // flight, `null` when the cell is empty / canvas not loaded / error.
  const [inspectAuthor, setInspectAuthor] = useState<PixelOccupancy | null | undefined>(undefined);
  // Monotonic token so a slow author lookup can't overwrite a newer inspection.
  const inspectReqRef = useRef(0);
  const pixelAuthorSourceRef = useRef<PixelAuthorSource>(pixelAuthorSource);
  pixelAuthorSourceRef.current = pixelAuthorSource;
  // Pixel-click moderation (FEN-754 §8.2). `modArmed` is the action awaiting its
  // inline confirm (null = no action armed); `modPending` blocks the panel while
  // a mod action runs. Read the source through a ref so the bound handler always
  // sees the latest injected bridge.
  const [modArmed, setModArmed] = useState<ModAction | null>(null);
  const [modPending, setModPending] = useState(false);
  const moderationSourceRef = useRef<ModerationSource>(moderationSource);
  moderationSourceRef.current = moderationSource;
  // View-first auth (FEN-115): anonymous viewers watch/zoom/pick-colour freely;
  // the FIRST account-requiring interaction (enter draw mode / stage the first
  // cell, not only the commit) triggers the quasi-instant Twitch consent and
  // returns to this same canvas. Mirrored into a ref so the renderer's tap
  // callback (bound once) always reads the live session.
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const authedRef = useRef(false);
  authedRef.current = session != null;
  // Pre-OAuth value modal (FEN-580 / G1): null = closed, non-null = open.
  // `hasDrawIntent` distinguishes T1 (trying to draw) from T2 (explicit CTA).
  interface ModalData {
    callbackURL: string;
    errorCallbackURL?: string;
    streamer: string | null;
    hasDrawIntent: boolean;
  }
  const [modalData, setModalData] = useState<ModalData | null>(null);
  // Mirror into a ref so the bound-once renderer callbacks can read live state.
  const modalDataRef = useRef<ModalData | null>(null);
  modalDataRef.current = modalData;
  // Element that triggered the modal; focus is returned here on close (AC7 / E10).
  const modalTriggerRef = useRef<HTMLElement | null>(null);

  const [gauge, setGauge] = useState<GaugeState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  // G9 (AC6): track network-level offline independently of WS connection status.
  // `status` oscillates "closed" ↔ "connecting" during reconnect attempts; a banner
  // gated on `status==="closed"` therefore blinks off as soon as the first retry
  // starts. `isNetworkOffline` is set by the browser `offline` event and cleared by
  // `online` — it stays true across the whole offline period regardless of retries.
  const [isNetworkOffline, setIsNetworkOffline] = useState(false);
  // Track offline duration for OfflineBanner failed state (either condition).
  const [offlineTooLong, setOfflineTooLong] = useState(false);
  useEffect(() => {
    const isDisconnected = status === "closed" || isNetworkOffline;
    if (!isDisconnected) { setOfflineTooLong(false); return; }
    const id = setTimeout(() => setOfflineTooLong(true), 30_000);
    return () => clearTimeout(id);
  }, [status, isNetworkOffline]);
  // Monotonic count of server-initiated moderation bulk overwrites (wipe /
  // ban-and-wipe), bumped by net.ts on each `moderationEvent` frame (FEN-163).
  // Feeds the viewer-legibility reducer so `areaChanged` lights up (Lot I, FEN-121).
  const [bulkChangeSeq, setBulkChangeSeq] = useState(0);
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
  // move focus to the always-mounted rang-1 "puis-je poser" indicator (Lot E) —
  // which now shows the grown réserve via the effective gauge — so keyboard/SR
  // users keep their place right after the dopamine moment.
  const gaugeRef = useRef<HTMLParagraphElement>(null);
  const restoreClaimFocusRef = useRef(false);

  // Topbar reflow (FEN-283): the topbar can change height (e.g. it wraps a second
  // row on a narrow viewport). The floating status pill and the dock in landscape
  // use `--lp-topbar-h` to clear the bar's real bottom edge.
  const topbarRef = useRef<HTMLDivElement>(null);

  // G8 (FEN-616): Space held = continuous paint. When true, onHover auto-stages
  // the cell under the cursor as long as gauge has capacity. Stored in a ref so
  // the bound-once onHover callback always reads the live value.
  const spacePaintingRef = useRef(false);

  // G8 (FEN-616): cheat-sheet popover open state. A small dialog listing all
  // keyboard shortcuts; triggered by the "?" button in the topbar or the ? key.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsTriggerRef = useRef<HTMLButtonElement>(null);
  // Desktop R2 (FEN-1052): the "Raccourcis" nav link in the center topbar zone.
  // Focus returns here on desktop when the cheat-sheet closes.
  const shortcutsDesktopTriggerRef = useRef<HTMLButtonElement>(null);
  const shortcutsDialogRef = useRef<HTMLDivElement>(null);
  // Returns focus to whichever shortcuts trigger is currently visible.
  const focusShortcutsTrigger = useCallback(() => {
    (shortcutsDesktopTriggerRef.current ?? shortcutsTriggerRef.current)?.focus();
  }, []);

  // Topbar overflow menu (FEN-326 / AC-6): on a compact viewport the secondary
  // actions (gallery, "how it works", share, language) collapse behind a single
  // "More" disclosure instead of eating a permanent strip. Pure presentation —
  // desktop keeps them inline via CSS (AC-16), the trigger is `display:none`
  // there, so this state only matters on mobile. Closes on Escape / outside
  // click / item activation; focus returns to the trigger on Escape.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // S2 (FEN-1174): Studio panel open/close — orthogonal to menuOpen + panelOpen (R6).
  // Only ever true when isCanvasOwner===true; mounting StudioPanel is also guarded.
  const [studioOpen, setStudioOpen] = useState(false);
  const closeStudio = useCallback(() => setStudioOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // `pointerdown` (not click) so a tap outside dismisses before it acts.
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen]);

  // Cheat-sheet: close on outside pointer-down (AC6 — Esc is handled in the
  // G8 keyboard shortcuts effect above to avoid duplicate listeners).
  useEffect(() => {
    if (!shortcutsOpen) return;
    const onPointer = (e: PointerEvent): void => {
      if (
        !shortcutsDialogRef.current?.contains(e.target as Node) &&
        !shortcutsTriggerRef.current?.contains(e.target as Node)
      ) {
        setShortcutsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [shortcutsOpen]);

  // G4 (FEN-639): sound engine — WebAudio synthesis, localStorage persistence,
  // autoplay-policy handling. playPoseRef/playGaugeFullRef let the bound-once
  // net callbacks always invoke the current engine without re-running the effect.
  const { soundEnabled, setSoundEnabled, autoplayBlocked, playPose, playGaugeFull } =
    useSoundEngine();
  const playPoseRef = useRef(playPose);
  playPoseRef.current = playPose;
  const playGaugeFullRef = useRef(playGaugeFull);
  playGaugeFullRef.current = playGaugeFull;

  // OnboardingCoach (FEN-118): just-in-time hints. Created once per mount.
  const coachStorageRef = useRef(createLocalOnboardingStorage());
  const coachRef = useRef(new OnboardingCoach({ storage: coachStorageRef.current }));
  const [_coachHint, setCoachHint] = useState<OnboardingHint | null>(null);
  const dismissCoachHint = useCallback(() => setCoachHint(null), []);

  // G2 guided onboarding gate (FEN-584): porte 2-temps above the coach.
  const welcomeStorageRef = useRef(createLocalWelcomeStorage());
  const [gateState, setGateState] = useState<GateState>("hidden");
  const gateRef = useRef<GuidedOnboardingController | null>(null);
  const gateDialogRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null); // focus anchor before gate opens

  // Lazy-init gate controller with callbacks that reference stable refs.
  if (gateRef.current === null) {
    gateRef.current = new GuidedOnboardingController({
      welcomeStorage: welcomeStorageRef.current,
      callbacks: {
        onAim: () => {
          const hint = coachRef.current.send({ type: "aim" });
          if (hint) setCoachHint(hint);
        },
        onEvent: (evt, ts) => {
          // Instrumentation hook — swap for real analytics pipeline.
          const hook = (window as unknown as Record<string, unknown>)["_lpOnboardingEvent"];
          if (typeof hook === "function") hook(evt, ts);
        },
      },
    });
  }

  const _isTouchDevice = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches,
    [],
  );

  const sendGate = useCallback((event: Parameters<GuidedOnboardingController["send"]>[0]) => {
    if (!gateRef.current) return;
    gateRef.current.send(event);
    setGateState(gateRef.current.state);
  }, []);

  const openHowto = useCallback(() => {
    if (!gateRef.current) return;
    gateRef.current.openHowto();
    setGateState(gateRef.current.state);
  }, []);

  // R2 (FEN-370 AC-R2-1/4): closeable bottom panel (dock open/close state).
  // Persisted to localStorage so the user's preference survives page reload.
  const [panelOpen, setPanelOpenRaw] = useState(() => {
    try {
      return localStorage.getItem("lp:panel:open") !== "false";
    } catch {
      return true;
    }
  });
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  // FEN-1270: tracks hasActiveMode (inspect || drawing) so the ResizeObserver
  // can compute effectivePanelOpen without depending on hasActiveMode in its deps.
  const hasActiveModeRef = useRef(false);
  // True when the current zoom is at the fit-to-screen floor (drives ⊡ active).
  const [atFit, setAtFit] = useState(true);
  // Reactive limit flags — updated by onZoom so buttons disable at scale extremes.
  const [canZoomIn, setCanZoomIn] = useState(true);
  const [canZoomOut, setCanZoomOut] = useState(true);
  // ZoomControls button refs for focus-recovery (FEN-540 AC-1..3): when a zoom
  // limit is hit and the focused button becomes disabled, redirect focus to the
  // sibling or to ⊡ (never disabled) so keyboard users keep their place.
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const fitRef = useRef<HTMLButtonElement>(null);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
    try { localStorage.setItem("lp:panel:open", open ? "true" : "false"); } catch { /* ignore */ }
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".lp-hud .lp-panel-handle")?.focus()
    );
  }, [setPanelOpen]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".lp-hud .lp-panel-handle")?.focus()
    );
  }, [setPanelOpen]);

  // S3 (FEN-1341): BottomSheet owns drag/handle; onClose acts as a toggle so
  // clicking the peeking handle re-opens the sheet. Drag-dismiss only triggers
  // when the sheet is open, so the toggle is always semantically correct.
  const togglePanel = useCallback(() => {
    const next = !panelOpenRef.current;
    setPanelOpen(next);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".lp-hud .lp-panel-handle")?.focus()
    );
  }, [setPanelOpen]);

  // Dock height → renderer bottom inset (AC-R2-2/3) + CSS var for ZoomControls.
  // Runs on panel state change and whenever the dock content resizes.
  // S3 (FEN-1341): dockRef replaced by querySelector since BottomSheet owns the
  // container div; class .lp-hud is unique in this page so the query is safe.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".lp-hud");
    if (!el) return;
    const update = (): void => {
      const h = el.offsetHeight;
      // FEN-1270: in the no-mode state the sheet is always visible (gauge peek),
      // so effectivePanelOpen = panelOpen || !hasActiveMode. The bottom inset
      // accounts for the dock height in both peek and full-panel states.
      // FEN-1322: on desktop ≥1024px the HUD is a static flex sidebar (not a
      // bottom overlay): it shares the app row with the canvas and doesn't eat
      // into the canvas viewport vertically. Only apply a non-zero bottom inset
      // when the dock is genuinely a fixed-position bottom overlay (mobile).
      const isBottomDock = window.getComputedStyle(el).position === "fixed";
      const inset = isBottomDock && (panelOpenRef.current || !hasActiveModeRef.current) ? h : 0;
      rendererRef.current?.setBottomInset(inset);
      // Publish dock height as a CSS custom property so .lp-zoom-controls can
      // float just above the dock without a JS inline style cascade.
      document.documentElement.style.setProperty("--lp-dock-h", `${inset}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  // Re-run when panel open/closed state flips so inset immediately reflects.
  // hasActiveMode changes trigger a dock resize (content added/removed) which
  // fires the ResizeObserver automatically, so it is not in the deps here.
  }, [panelOpen]);

  // Sticky ban learned from a WS `banned` error — lets the unified indicator
  // (Lot E) keep showing "banned" pre-click after the first refusal. The backend
  // canPlace now also evaluates bans (FEN-132), so this is a belt-and-braces
  // fallback for the null-slug default canvas.
  const [bannedHint, setBannedHint] = useState(false);

  // Unified "puis-je poser ?" inputs (Lot E, FEN-117). The session is the same
  // `authClient.useSession()` read above for the FEN-115 view-first gate
  // (`authedRef`); `authenticated` reuses it so the indicator and the consent
  // gate agree on auth. The canvas doc (status + event window) and its
  // permission contract come from Convex, skipped when there is no slug.
  const authenticated = !!session;
  const canvasDoc = useQuery(getCanvasBySlugRef, slug ? { slug } : "skip");
  const canvasId = canvasDoc?._id ?? null;
  const permissionResult = useQuery(canPlaceRef, canvasId ? { canvasId } : "skip");
  // Map slug + live canPlace → the unified indicator's permission input. The
  // default canvas (slug null) has no canPlace contract and is implicitly open,
  // so this yields `{ allowed: true }` (gateway-authoritative) instead of the
  // `undefined` that would pin it at "loading" forever — see resolvePermission
  // (FEN-277). A slugged canvas forwards the live result (undefined → loading).
  const permission = resolvePermission(slug, permissionResult);

  /** Push the staged batch + hovered cell to the renderer and re-render the HUD. */
  const syncOverlay = useCallback(() => {
    rendererRef.current?.setOverlay(selectionRef.current.entries(), hoverRef.current);
    setSelVersion((n) => n + 1);
  }, []);

  const showToast = useCallback((f: ToastState) => {
    setToast({ kind: f.kind, messageKey: f.messageKey, params: f.params });
  }, []);

  // Gate an account-requiring interaction (FEN-115 / FEN-580). Anonymous viewers
  // see the pre-OAuth value modal (G1); they can dismiss or proceed to Twitch.
  // The modal is idempotent: if already open, the second call is a no-op (E7).
  // Returns false so the caller stops (the modal takes over). Cancelling at Twitch
  // is non-punitive — the viewer simply returns in read-only mode (E2).
  const requireAccount = useCallback(
    (interaction: CanvasInteraction): boolean => {
      const currentPath = typeof window !== "undefined" ? window.location.pathname : "/";
      const decision = gateInteraction(interaction, authedRef.current, {
        slug,
        currentPath,
        errorCallbackURL: sanitizeReturnTo(currentPath) ?? "/",
      });
      if (decision.kind === "consent") {
        if (modalDataRef.current === null) {
          // Capture triggering element for focus return (E10 / AC7).
          modalTriggerRef.current =
            typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
          setModalData({
            callbackURL: decision.callbackURL,
            errorCallbackURL: decision.errorCallbackURL,
            streamer: slug ?? null,
            hasDrawIntent: true, // T1: user was trying to draw
          });
        }
        // If already open (E7 idempotent guard): do nothing.
        return false;
      }
      return true;
    },
     
    [slug],
  );

  // FEN-924: dock CTA for anonymous users bypasses the value modal and goes
  // directly to Twitch OAuth. No draw intent, no staged batch → nothing to
  // persist before the redirect.
  const handleDirectSignIn = useCallback(() => {
    const currentPath = typeof window !== "undefined" ? window.location.pathname : "/";
    const callbackURL = canvasCallbackURL(slug, currentPath);
    const errorCallbackURL = sanitizeReturnTo(currentPath) ?? "/";
    void signInWithTwitch({ callbackURL, errorCallbackURL });
  }, [slug]);

  // Dismiss the modal without authenticating (E8 / E2): return to read-only state.
  // The batch stays in memory (not lost), focus returns to the trigger element.
  const dismissModal = useCallback(() => setModalData(null), []);

  // Called by AuthModal just before it starts the OAuth redirect (AC4 / spec §5.4):
  // persist the staged batch and the draw intent + view cadrage to sessionStorage
  // so they survive the OAuth round-trip.
  const persistReturnTrip = useCallback(() => {
    if (!slug) return;
    const cells = selectionRef.current.entries();
    if (cells.length > 0) saveBatch(slug, cells);
    if (modalDataRef.current?.hasDrawIntent) {
      const viewState = rendererRef.current?.getViewState();
      saveReturnIntent(slug, {
        intent: "draw",
        ...(viewState ?? {}),
      });
    }
  }, [slug]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convexAuthed, slug]);

  // Stage / toggle / recolor a cell with the current tool (the batch gesture).
  const stageCell = useCallback(
    (x: number, y: number) => {
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
      // Coach: first cell staged → marks experienced if aim not yet shown.
      coachRef.current.send({ type: "stage" });
      const c = erasingRef.current ? EMPTY_COLOR : colorRef.current;
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

  // Close the pixel-info panel (FEN-249). Bumping the request token also voids
  // any in-flight author lookup so its late result can't reopen stale state.
  const closeInspect = useCallback(() => {
    inspectReqRef.current += 1;
    setInspect(null);
  }, []);

  // Open the pixel-info panel for a clicked cell (FEN-249). Read-only: it shows
  // coordinates + author and NEVER stages a cell (selection starts via
  // "Dessiner"). Inspection is allowed in every place-state. An empty/unloaded
  // cell needs no lookup; a painted one resolves the author via the injected
  // source (inert until the backend hook lands → "author unavailable").
  // FEN-797: always open the bottom sheet so the pixel-info content is visible.
  const openInspect = useCallback((x: number, y: number) => {
    setInspect({ x, y });
    openPanel();
    const color = rendererRef.current?.colorAt(x, y) ?? -1;
    if (color <= 0) {
      // Empty (0) or unloaded (<0): no placer to look up.
      inspectReqRef.current += 1;
      setInspectAuthor(null);
      return;
    }
    setInspectAuthor(undefined); // loading
    const req = (inspectReqRef.current += 1);
    Promise.resolve(pixelAuthorSourceRef.current.authorAt(x, y))
      .then((a) => {
        if (inspectReqRef.current === req) setInspectAuthor(a);
      })
      .catch(() => {
        if (inspectReqRef.current === req) setInspectAuthor(null);
      });
  }, [openPanel]);

  // FEN-390: keep the renderer's marching-ants frame in sync with the
  // inspected cell. Clear when the panel closes (inspect=null) or when draw
  // mode starts (pixelInfo unmounts — the frame must disappear with it).
  useEffect(() => {
    rendererRef.current?.setInspectedCell(!drawing && inspect ? inspect : null);
  }, [inspect, drawing]);

  // "Dessiner": leave the info panel and enter draw mode. Account-gated (FEN-115):
  // entering draw mode is itself an account-requiring interaction.
  // D-A (spec §3 FEN-797): pre-aim the inspected cell (hover highlight) but do NOT
  // stage it — the user explicitly taps cells to stage them in draw mode.
  const drawFromInspect = useCallback(() => {
    if (!inspect) return;
    if (!requireAccount("enter-draw")) return;
    const { x, y } = inspect;
    setDrawing(true);
    closeInspect();
    // FEN-797: ensure the bottom sheet is open so the palette is immediately visible.
    openPanel();
    // Pre-aim: show the hover cursor at the tapped cell without staging it.
    hoverRef.current = { x, y };
    rendererRef.current?.setOverlay(selectionRef.current.entries(), { x, y });
  }, [inspect, requireAccount, closeInspect, openPanel]);

  // Moderation (FEN-754 §8.2): a newly inspected (or closed) cell disarms any
  // half-confirmed mod action so a confirm never carries over to another pixel.
  useEffect(() => {
    setModArmed(null);
    setModPending(false);
  }, [inspect]);

  // Run an armed pixel-click moderation action on the inspected cell, then toast
  // the outcome and close the panel on success (the wipe arrives live over the WS
  // delta stream, so no manual repaint). All three actions are mod-authorised
  // server-side; the source swallows errors to `{ ok:false }` so this never throws.
  const runModAction = useCallback(
    async (action: ModAction): Promise<void> => {
      if (!inspect) return;
      const { x, y } = inspect;
      setModPending(true);
      const src = moderationSourceRef.current;
      const res =
        action === "deletePixel"
          ? await src.deletePixel(x, y)
          : action === "deleteGroup"
            ? await src.deleteGroup(x, y)
            : await src.banAuthor(x, y);
      setModPending(false);
      setModArmed(null);
      if (res.ok) {
        showToast({
          kind: "success",
          messageKey:
            action === "deletePixel"
              ? "canvas.mod.pixelDeleted"
              : action === "deleteGroup"
                ? "canvas.mod.groupDeleted"
                : "canvas.mod.banned",
          params: { count: res.cellsAffected },
        });
        closeInspect();
      } else {
        showToast({
          kind: "rejected",
          messageKey: res.detail === "no_author" ? "canvas.mod.noAuthor" : "canvas.mod.failed",
        });
      }
    },
    [inspect, showToast, closeInspect],
  );

  // "Poser ici" (FEN-338 / maquette): the dock's persistent primary CTA when no
  // batch is staged yet. It opens placement (enters draw mode) so the always-on
  // CTA in the maquette has a behaviour — tapping it invites aiming a cell, which
  // then stages and flips the CTA to "Confirmer". Account-gated exactly like the
  // info-panel "Dessiner" entry (entering draw mode is account-requiring, FEN-115).
  const startPose = useCallback(() => {
    if (!requireAccount("enter-draw")) return;
    setDrawing(true);
    // FEN-797: ensure the bottom sheet is open so the palette is immediately visible.
    openPanel();
  }, [requireAccount, openPanel]);

  // G7 (FEN-627) — "Poser ici" mobile FAB: arms the centered-reticle pixel in
  // one tap and opens the panel (color selector). The target is the canvas
  // viewport center (the user frames by panning/pinching, then taps). Account-
  // gated like all draw-mode entry (FEN-115). No accidental pose during pan/pinch
  // because this is an explicit button tap, not a canvas gesture (AC5).
  const placeHereAtCenter = useCallback(() => {
    if (!requireAccount("enter-draw")) return;
    setDrawing(true);
    openPanel();
    const el = canvasRef.current;
    const renderer = rendererRef.current;
    if (renderer && el) {
      const rect = el.getBoundingClientRect();
      const cell = renderer.toCell(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (cell) stageCell(cell.x, cell.y);
    }
  }, [requireAccount, openPanel, stageCell]);

  // Cancel: clear any staged cells, close the info panel, and exit draw mode
  // returning to VISIT state (S2 → S0 per FEN-797 spec §1).
  const cancel = useCallback(() => {
    selectionRef.current.clear();
    closeInspect();
    setDrawing(false);
    hoverRef.current = null;
    syncOverlay();
  }, [syncOverlay, closeInspect]);

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

  // Dynamic topbar offset (FEN-283): publish the topbar's real bottom edge as
  // `--lp-topbar-h` so the floating status pill and the landscape dock always
  // clear it, even when the bar wraps to a second row. ResizeObserver covers
  // content/locale/auth-state changes; window resize covers breakpoint flips.
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const publish = () => {
      const bottom = el.offsetTop + el.offsetHeight;
      el.ownerDocument.documentElement.style.setProperty("--lp-topbar-h", `${bottom}px`);
      // Top inset for the renderer = how many CSS px of the *canvas* are covered
      // by the topbar. On mobile the canvas fills the viewport (canvasTop ≈ 0) so
      // overlap = topbar bottom. On desktop R2 the canvas starts below the topbar
      // (canvasTop ≈ topbar height) so overlap = 0 — no inset needed (FEN-1060).
      const canvasTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
      rendererRef.current?.setTopInset(Math.max(0, bottom - canvasTop));
    };
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, []);

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

  // Tick once a second while the gauge is recharging (NOT full) so the countdown
  // re-renders and the re-peek fires at each expiry — this is what makes the
  // charge count climb live (10/20 → 11/20 → 12/20 …, FEN-1482). The server is
  // authoritative and never pushes refill ticks on its own, so at every expiry
  // epoch we peek and let the fresh `gauge` frame carry the incremented charges
  // and the restarted cooldownUntil. Guarded on `cooldownUntil === 0` (⇔ full,
  // regen paused) rather than `charges > 0`: the old guard stopped ticking after
  // the first refill (0→1), freezing partially-filled gauges (the reported bug).
  const peekSentForRef = useRef<number>(0); // cooldownUntil already peeked — avoids spam
  useEffect(() => {
    if (gauge === null || gauge.cooldownUntil === 0) return; // cooldownUntil 0 ⇔ full: regen paused
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

  // Coach: fire `arrive` once the WS connection opens.
  useEffect(() => {
    if (status !== "open") return;
    const hint = coachRef.current.send({ type: "arrive" });
    if (hint) setCoachHint(hint);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === "open"]); // intentionally coarse — fires once on first open

  // Refs for the coach/gate effects that depend on placeState/pendingTiers —
  // those are derived later in the component, so these effects are hoisted there.
  const sentGaugeEmptyRef = useRef(false);
  const prevPendingTiersRef = useRef(0);

  // Gate focus trap: when the gate opens/closes, manage focus.
  useEffect(() => {
    const isOpen = gateState !== "hidden" && gateState !== "done";
    if (isOpen) {
      // Save where focus was and move it into the dialog.
      prevFocusRef.current = document.activeElement;
      requestAnimationFrame(() => {
        const el = gateDialogRef.current;
        if (!el) return;
        const first = el.querySelector<HTMLElement>("[autofocus], button, [tabindex]");
        first?.focus();
      });
    } else if (prevFocusRef.current) {
      // Return focus to canvas (or wherever it was) on close.
      const target = prevFocusRef.current as HTMLElement;
      prevFocusRef.current = null;
      requestAnimationFrame(() => target?.focus?.());
    }
  }, [gateState]);

  // Gate focus trap keyboard handling (Tab cycle + Escape).
  useEffect(() => {
    const isOpen = gateState !== "hidden" && gateState !== "done";
    if (!isOpen || !gateDialogRef.current) return;
    const el = gateDialogRef.current;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        sendGate("escape");
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [gateState, sendGate]);

  // G8 (FEN-616): global keyboard shortcuts — E/I/G/M tool switches, Space for
  // continuous paint, Esc to close cheat-sheet, ? to toggle it.
  // Safety guards: skip when a text input has focus (AC5), skip pose shortcuts
  // while the G2 onboarding gate is open (edge-case matrix row 2).
  useEffect(() => {
    const isGateOpen = gateState !== "hidden" && gateState !== "done";

    const onKeyDown = (e: KeyboardEvent): void => {
      // Never intercept when typing in a form field.
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) return;
      // Skip OS-level combos (Ctrl/Cmd+anything).
      if (e.ctrlKey || e.metaKey) return;
      // If the canvas-focused renderer already handled the key, only continue for
      // Esc/? which have cheat-sheet side-effects that belong to the React layer.
      if (e.defaultPrevented && e.key !== "Escape" && e.key !== "?") return;

      // Esc: close cheat-sheet first; gate/menu handlers manage their own Esc.
      if (e.key === "Escape") {
        if (shortcutsOpen) {
          e.preventDefault();
          setShortcutsOpen(false);
          focusShortcutsTrigger();
        }
        return;
      }

      // "?" key: toggle cheat-sheet.
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }

      // Pose shortcuts disabled while the blocking onboarding gate is open.
      if (isGateOpen) return;

      switch (e.code) {
        case "KeyE":
          // Eraser toggle (when canvas NOT focused — renderer handles canvas-focus case).
          if (!e.repeat) { setErasing((prev) => !prev); }
          break;
        case "KeyI":
          // Eyedropper: pick the colour at the hovered cell (mouse hover position).
          if (!e.repeat) {
            const cell = hoverRef.current;
            if (cell) {
              const c = rendererRef.current?.colorAt(cell.x, cell.y) ?? 0;
              if (c > 0) { setColor(c); setErasing(false); }
            }
          }
          break;
        case "KeyG":
          if (!e.repeat) { rendererRef.current?.toggleGrid(); }
          break;
        case "KeyM":
          // M = pan mode: exit draw mode so clicks open inspect, not stage.
          if (!e.repeat) { setDrawing(false); }
          break;
        case "Space":
          // Prevent page scroll; start continuous paint on first press.
          e.preventDefault();
          if (!e.repeat) {
            spacePaintingRef.current = true;
            if (!drawingRef.current) startPose();
          }
          break;
        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") spacePaintingRef.current = false;
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [gateState, shortcutsOpen, startPose]);

  // Mount: build renderer + net client, connect. Teardown on unmount.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const renderer = new CanvasRenderer(
      el,
      {
        onTap: (x, y, _pointerType) => {
          // In draw mode → stage the cell (the prior selection behaviour;
          // stageCell prevents staging when blocked and explains why).
          if (drawingRef.current) {
            stageCell(x, y);
            return;
          }
          // FEN-797: all taps (touch and mouse/pen) open the pixel-info panel.
          // "Dessiner" is the explicit gate to draw mode — never enter it on tap.
          openInspect(x, y);
        },
        // FEN-788: long-press on touch = inspect (resolves tap=pose vs tap=inspect
        // collision). Reuses existing inspectedCell marching-ants frame.
        onLongPress: (x, y) => {
          openInspect(x, y);
        },
        onHover: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
          // G8 continuous paint: while Space is held and we are in draw mode,
          // each new hover cell is staged automatically (like dragging a brush).
          if (cell && spacePaintingRef.current && drawingRef.current) {
            stageCell(cell.x, cell.y);
          }
        },
        // ZoomControls ⊡ active indicator (AC-R2-3, FEN-370).
        // Also refreshes zoom-limit flags so +/− disable at extremes (FEN-414).
        // Focus-recovery (FEN-540 WCAG 2.4.3): if the button that is about to
        // be disabled currently holds focus, redirect to the sibling before the
        // browser ejects focus to <body>. Uses rAF so the move runs after React
        // commits `disabled` (same pattern as panelHandleRef.current?.focus()).
        onZoom: (fit: boolean) => {
          const newCanZoomIn = rendererRef.current?.canZoomIn ?? true;
          const newCanZoomOut = rendererRef.current?.canZoomOut ?? true;
          const active = document.activeElement;
          if (!newCanZoomIn && active === zoomInRef.current) {
            requestAnimationFrame(() => {
              if (newCanZoomOut) zoomOutRef.current?.focus();
              else fitRef.current?.focus();
            });
          } else if (!newCanZoomOut && active === zoomOutRef.current) {
            requestAnimationFrame(() => {
              if (newCanZoomIn) zoomInRef.current?.focus();
              else fitRef.current?.focus();
            });
          }
          setAtFit(fit);
          setCanZoomIn(newCanZoomIn);
          setCanZoomOut(newCanZoomOut);
        },
        // Keyboard roving cursor (FEN-123): same stage/validate/cancel gestures
        // as the pointer (true 3-modality parity) + a polite SR announce of the
        // targeted cell and whether it's already staged.
        onCursorMove: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
          const staged = selectionRef.current.has(cell.x, cell.y);
          setAnnounce(tRef.current(staged ? "canvas.cursorAtStaged" : "canvas.cursorAt", cell));
        },
        // Keyboard Enter/Space mirrors a click (FEN-249 3-modality parity): in
        // draw mode it stages, otherwise it opens the pixel-info panel.
        onActivate: (x, y) => {
          if (drawingRef.current) stageCell(x, y);
          else openInspect(x, y);
        },
        onCancel: () => cancel(),
        onValidate: () => validate(),
        // G8 (FEN-616): tool-switch hooks fired by the renderer when canvas focused.
        onEraserToggle: () => setErasing((e) => !e),
        onEyedropper: (colorIndex) => {
          if (colorIndex > 0) { setColor(colorIndex); setErasing(false); }
        },
        // onGridToggle: renderer handles gridEnabled internally; no React state needed.
        onShortcutHelp: () => setShortcutsOpen((o) => !o),
      },
      // Transparent backing so the neutral Arcade field (FrescoCanvas:
      // `--canvas-field`, FEN-269) shows in the letterbox around the board
      // instead of the legacy dark backdrop — chromatic neutrality so a posed
      // pixel reads true. The board pixels themselves are still painted opaque.
      {
        interactive: true,
        background: null,
        // Cover the viewport (no neutral dead field) on compact viewports (B1).
        // F1 (FEN-716): fit-to-visible-zone at mount so the entire fresco is visible on
        // mobile. Cover mode (fill viewport, crop the board) replaced by contain fit
        // (entire board visible, neutral field in the letterbox). The ⊡ button and
        // pinch-zoom let the user re-zoom after the initial fit.
        cover: false,
      },
    );
    rendererRef.current = renderer;
    // Seed the topbar inset so the board border is correct from the first frame
    // (the topbar publish effect runs before this effect but rendererRef is not
    // set yet at that point — FEN-470).
    if (topbarRef.current) {
      const topbarBottom = topbarRef.current.offsetTop + topbarRef.current.offsetHeight;
      const canvasTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
      renderer.setTopInset(Math.max(0, topbarBottom - canvasTop));
    }

    const net = new CanvasNetClient({
      url: gatewayWsUrl(slug),
      // Carry the live Convex JWT so the gateway resolves `userId` and pushes the
      // per-user `gauge` that ungates placement (FEN-184/FEN-267). Read via a ref
      // so the auth-flip reconnect below re-runs the current resolver.
      fetchTicket: () => fetchTicketRef.current(),
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
                if (f.kind === "banned") {
                  selectionRef.current.setLocked(true);
                  setBannedHint(true); // sticky → unified indicator shows "banned" pre-click
                }
                if (f.kind === "cooldown") return; // state indicator already shows this
                showToast(f);
              },
              onPlaced: () => {
                // First server-confirmed placement: coach → firstPixel hint.
                const hint = coachRef.current.send({ type: "placed" });
                if (hint) setCoachHint(hint);
                // G2: time-to-first-pixel instrumentation.
                gateRef.current?.notifyFirstPixelPlaced();
                // Auto-close gate if user acted while it was open (E4).
                if (gateRef.current) {
                  const prev = gateRef.current.state;
                  if (prev !== "hidden" && prev !== "done") {
                    gateRef.current.send("external-action");
                    setGateState(gateRef.current.state);
                  }
                }
              },
              onCommitted: ({ erased }) => {
                // G4 (AC1): play pose sound on confirmed paint (throttled, see useSoundEngine).
                if (!erased) playPoseRef.current();
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
        // A moderation bulk overwrite landed: surface the net layer's monotonic
        // counter so the liveness effect below fires the `areaChanged` notice. A
        // reconnect resync never reaches here, so a network blip stays silent.
        onModerationEvent: (ev) => setBulkChangeSeq(ev.bulkChangeSeq),
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
    // FEN-569: open immediately only for anonymous viewers or when Convex has
    // already confirmed auth. When a Better Auth session exists but the Convex
    // JWT isn't validated yet (post-OAuth landing), defer the initial connect to
    // the auth-flip effect below — this eliminates the anonymous-open →
    // JWT-reconnect double-hop (1 saved handshake + 1 saved Redis snapshot).
    if (convexAuthed || !authedRef.current) {
      wsConnectedRef.current = true;
      void net.connect();
    }

    return () => {
      net.disconnect();
      renderer.destroy();
      rendererRef.current = null;
      netRef.current = null;
      placementRef.current = null;
      wsConnectedRef.current = false;
    };
    // `convexAuthed` is intentionally NOT a dep: re-auth on auth flips is owned by a
    // separate effect (keyed on convexAuthed) so the renderer/socket is built once
    // per slug, not torn down and rebuilt on every login state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, showToast, stageCell, validate, cancel, openInspect]);

  // Re-authenticate the socket when Convex auth flips (FEN-184 / FEN-569). When
  // a session is present but the JWT wasn't ready at mount (post-OAuth landing),
  // the mount effect above defers the initial connect; this effect fires the first
  // open with a token, saving one anonymous handshake + Redis snapshot. On a normal
  // auth flip (false → true mid-session) the same path fires. On sign-out
  // (true → false) it reconnects to the anonymous read-only socket.
  const prevConvexAuthedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevConvexAuthedRef.current === null) {
      prevConvexAuthedRef.current = convexAuthed;
      // If mount deferred the initial connect (session present, JWT not yet
      // confirmed) and Convex is now authed, fire the first connect here.
      if (!wsConnectedRef.current && convexAuthed) {
        wsConnectedRef.current = true;
        netRef.current?.connect();
      }
      return;
    }
    if (prevConvexAuthedRef.current === convexAuthed) return;
    prevConvexAuthedRef.current = convexAuthed;
    if (!wsConnectedRef.current) {
      // Deferred initial connect: fire first open with the token.
      wsConnectedRef.current = true;
      netRef.current?.connect();
    } else {
      netRef.current?.reconnect();
    }
  }, [convexAuthed]);

  // Re-peek the gauge on tab focus or visibility restore (covers long absences
  // where the setInterval was throttled, and accumulation beyond refillIntervalSec).
  // Peek whenever regen is active (cooldownUntil > 0 ⇔ not full), not only when
  // empty, so a partially-filled gauge that recharged in the background reconciles
  // its climbed charge count the instant the tab regains focus (FEN-1482).
  useEffect(() => {
    const peek = () => {
      if (gauge !== null && gauge.cooldownUntil > 0) netRef.current?.requestGaugePeek();
    };
    document.addEventListener("visibilitychange", peek);
    window.addEventListener("focus", peek);
    return () => {
      document.removeEventListener("visibilitychange", peek);
      window.removeEventListener("focus", peek);
    };
  }, [gauge]);

  // G9 (AC6): show OfflineBanner immediately when the browser loses network.
  // The WS onClose fires only after the OS-level TCP keepalive times out (~60s),
  // so ctx.setOffline(true) in Playwright (or the native offline event) would
  // leave the banner invisible for too long. Listening to `offline` gives instant
  // feedback and sets `isNetworkOffline` so the banner persists through reconnect
  // attempts (status oscillates "closed"↔"connecting", which would hide the banner
  // every retry cycle). `online` clears the flag and triggers a WS reconnect.
  useEffect(() => {
    const onOffline = () => { setIsNetworkOffline(true); setStatus("closed"); };
    const onOnline = () => { setIsNetworkOffline(false); netRef.current?.reconnect(); };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Cooldown view-state at component scope: read by the per-second tick re-render
  // and the mini-jauge countdown (FEN-627). Based on the real server gauge (the
  // optimistic tier overlay folds charges in separately and never moves cooldownUntil).
  const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
  const cooldownSeconds =
    onCooldown && gauge !== null ? Math.max(0, Math.ceil((gauge.cooldownUntil - Date.now()) / 1000)) : 0;

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

  // The single unified "puis-je poser ?" answer (Lot E, FEN-117): one indicator,
  // yes/no + why + when, recomputed each render (the per-second tick re-renders
  // so the cooldown countdown stays live). The actual colour/icon is delegated
  // to the UI phase — here we render the text label only (C6).
  const placeState = derivePlaceState({
    connection: toConnectionState(status),
    authenticated,
    // Combine the Convex-loading optimistic hint (FEN-957) with Better Auth's
    // own isPending window — either pending state suppresses the signedOut flash
    // (AP-12).
    authPending: authPending || sessionPending,
    permission,
    eventStartAt: canvasDoc?.eventStartAt ?? null,
    eventEndAt: canvasDoc?.eventEndAt ?? null,
    gauge: effectiveGauge,
    bannedHint,
    now: Date.now(),
  });
  canPlaceNowRef.current = placeState.canPlace;
  blockedMsgRef.current = placeState.messageKey;

  // Cooldown engagement view (Lot F, FEN-119): from the SAME effective gauge the
  // unified indicator reads, plus the armed-batch size, recomputed each render
  // (the per-second tick keeps the countdown live). It governs the
  // forward-oriented countdown line and the arming affordance. Arming is allowed
  // whenever posing is (ready) OR while cooling — the one edge Lot E forbids
  // commit but Lot F still lets you aim ahead.
  const cooldownView = effectiveGauge
    ? deriveCooldownView({
        charges: effectiveGauge.charges,
        cooldownUntil: effectiveGauge.cooldownUntil,
        now: Date.now(),
        staged: selectionRef.current.count,
      })
    : null;
  const canArmNow = placeState.canPlace || placeState.kind === "cooldown";
  canArmNowRef.current = canArmNow;
  onCooldownRef.current = placeState.kind === "cooldown";
  cooldownSecondsRef.current = cooldownView?.secondsUntilNext ?? 0;

  // G4 (AC2): gauge-full sound — one jingle per full TRANSITION, not on initial
  // load or per tick. Track previous full state via a ref so the effect only fires
  // when the gauge crosses the full threshold from below.
  const gaugeIsFull =
    effectiveGauge !== null &&
    effectiveGauge.max > 0 &&
    effectiveGauge.charges >= effectiveGauge.max;
  const gaugeWasFullRef = useRef(false);
  useEffect(() => {
    if (gaugeIsFull && !gaugeWasFullRef.current) playGaugeFullRef.current();
    gaugeWasFullRef.current = gaugeIsFull;
  }, [gaugeIsFull]);

  // Viewer legibility of moderation events (Lot I, FEN-121): explain a collective
  // event without jargon or anxiety. Two signals feed the reducer: the
  // frozen/reopen transition (via canPlace → placement_closed → the `frozen`
  // state) and the wipe `areaChanged` signal — the monotonic `bulkChangeSeq` the
  // net layer bumps on each server-initiated `moderationEvent` frame (FEN-163,
  // distinct from a reconnect resync). Kept out of the unified place-state
  // indicator: this is a transient "something happened" banner, not the standing
  // "can I place?" answer, and it announces politely (never an alert).
  const prevLivenessRef = useRef<CanvasLiveness>({ frozen: false, bulkChangeSeq: 0 });
  const [_modNotice, setModNotice] = useState<MessageKey | null>(null);
  const frozenNow = placeState.kind === "frozen";
  useEffect(() => {
    const prev = prevLivenessRef.current;
    const next: CanvasLiveness = { frozen: frozenNow, bulkChangeSeq };
    const notice = deriveModerationNotice(prev, next);
    prevLivenessRef.current = next;
    if (!notice) return;
    setModNotice(notice.messageKey);
    const timer = setTimeout(() => setModNotice(null), notice.autoDismissMs);
    return () => clearTimeout(timer);
  }, [frozenNow, bulkChangeSeq]);

  // Coach: nudge `gauge-empty` when placement enters cooldown (first time).
  // (Declared after placeState because it reads placeState.kind.)
  useEffect(() => {
    if (placeState.kind !== "cooldown" || sentGaugeEmptyRef.current) return;
    sentGaugeEmptyRef.current = true;
    const hint = coachRef.current.send({
      type: "gauge-empty",
      params: { seconds: placeState.params?.seconds ?? 0 },
    });
    if (hint) setCoachHint(hint);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeState.kind]);

  // Coach: fire `tier-available` when pending tiers first appear.
  // (Declared after pendingTiers because it reads pendingTiers.)
  useEffect(() => {
    if (pendingTiers > 0 && prevPendingTiersRef.current === 0) {
      const hint = coachRef.current.send({ type: "tier-available" });
      if (hint) setCoachHint(hint);
    }
    prevPendingTiersRef.current = pendingTiers;
  }, [pendingTiers]);

  // G2 gate trigger: re-evaluate conditions whenever auth, placeState, or canvasId changes.
  // (Declared after placeState because it reads placeState.kind.)
  useEffect(() => {
    if (!gateRef.current) return;
    const prevGateState = gateRef.current.state;
    gateRef.current.tryTrigger({
      authenticated,
      placeKind: placeState.kind,
      isOwner: false, // viewers accessing /[slug] are never owners (owners use studio)
      canvasId,
      welcomeStorage: welcomeStorageRef.current,
      modelLearned: isModelLearned(coachStorageRef.current),
    });
    if (gateRef.current.state !== prevGateState) setGateState(gateRef.current.state);
   
  }, [authenticated, placeState.kind, canvasId]);

  const sel = selectionRef.current;
  const count = sel.count; // re-read each render; selVersion forces the refresh
  void selVersion;

  // FEN-1249: `canModerate` removed from hasActiveMode — it is a permission
  // (always true for owners), not a display mode. Mod UI only mounts when
  // `inspect && !drawing` (see pixelInfo block below), so `inspect` gates it.
  // FEN-1270: handle shown only when an interactive mode is active — in the
  // default idle state the sheet stays at gauge-only "peek" height with no
  // handle and no drag-dismiss.
  const hasActiveMode = !!inspect || drawing;
  hasActiveModeRef.current = hasActiveMode;
  // FEN-1270: gauge is always visible → treat the panel as "open" when there
  // is no active mode so the sheet never slides fully off-screen.
  const effectivePanelOpen = panelOpen || !hasActiveMode;
  const showHandle = computeShowHandle(inspect, drawing);

  // FEN-1079: data-mode for CSS gating — pixel-info, draw, or idle.
  const hudMode: "pixel-info" | "draw" | "none" =
    inspect ? "pixel-info" : (drawing || count > 0) ? "draw" : "none";

  // Pixel-info panel view-model (FEN-249): only while a cell is inspected and we
  // are not in draw mode. The colour comes from the renderer (−1 if unloaded);
  // the pure reducer turns colour + resolved author into the panel's author
  // state. The author line maps each state to its localized string.
  const pixelInfo =
    inspect && !drawing
      ? derivePixelInfo({
          x: inspect.x,
          y: inspect.y,
          color: rendererRef.current?.colorAt(inspect.x, inspect.y) ?? -1,
          author: inspectAuthor,
        })
      : null;
  const pixelInfoAuthorText = pixelInfo
    ? pixelInfo.authorState === "known"
      ? t("canvas.pixelInfo.authorKnown", { login: pixelInfo.authorLogin ?? "" })
      : pixelInfo.authorState === "empty"
        ? t("canvas.pixelInfo.authorEmpty")
        : pixelInfo.authorState === "loading"
          ? t("canvas.pixelInfo.authorLoading")
          : t("canvas.pixelInfo.authorUnknown")
    : "";
  // Date/time of the placement, formatted for the active locale (FEN-755).
  const pixelInfoDateText = pixelInfo?.ts != null
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(pixelInfo.ts),
      )
    : null;

  // G9 (AC3): canvas definitively not found → full StateScreen, not a StatusPill.
  // canvasDoc===undefined means still loading; null means resolved & not found.
  if (slug && canvasDoc === null) {
    return (
      <div className="lp-app">
        <StateScreen
          id="canvas-gone"
          kicker={t("state.canvas.kicker")}
          title={t("state.canvas.title")}
          subtitle={t("state.canvas.sub")}
          art={<StateArt.canvasGone />}
          primary={{ label: t("state.canvas.cta1"), href: paths.gallery() }}
          secondary={{ label: t("state.canvas.cta2"), href: paths.home() }}
        />
      </div>
    );
  }

  return (
    <div className="lp-app">
      {/* Neutral framed field around the live board (FrescoCanvas, FEN-269):
          chromatic neutrality so a posed pixel reads true (selector == pixel).
          The canvas keyboard a11y (text alternative + polite cursor readout,
          FEN-123/U3) rides inside the frame as the canvas's described-by. */}
      {/* G9 (AC6): non-blocking offline reconnection overlay (not a blocking wall).
          Show when network-offline (persistent across reconnect retries) OR when the
          WS is closed for any other reason (brief WS blip). */}
      {(isNetworkOffline || status === "closed") && (
        <OfflineBanner
          failed={offlineTooLong}
          titleReconnecting={t("state.offline.title")}
          titleFailed={t("state.offline.failed")}
          labelReload={t("state.offline.reload")}
        />
      )}
            <FrescoCanvas ref={canvasRef} ariaLabel={t("canvas.canvasLabel")} ariaDescribedBy="lp-canvas-help">
        <p id="lp-canvas-help" className="lp-sr-only">
          {t("canvas.keyboardHelp")}
        </p>
        {/* Polite readout of the keyboard cursor cell (and whether it's staged). */}
        <p className="lp-sr-only" aria-live="polite">
          {announce}
        </p>
      </FrescoCanvas>

      <div className="lp-topbar" ref={topbarRef}>
        {/* Brand wordmark (FEN-338 / handoff §3.2) — corrects défaut "aucune
            marque". Shown only on the mobile fine bar (left); on desktop the
            global chrome owns the brand, so this is `display:none` there and the
            floating top-right bar is left untouched (AC-9). */}
        <Wordmark size="sm" className="lp-topbar-brand" />
        {/* Right-hand cluster: live counter + the overflow menu. `display:contents`
            on desktop so the children flatten inline exactly as before (AC-9); on
            the mobile bar it is the flex group pushed to the right. */}
        <div className="lp-topbar-actions">
          {/* Connection state is no longer a separate topbar pill: the unified
              Arcade StatusPill (floated over the canvas on mobile) carries
              connecting/offline as part of the single "puis-je poser ?" answer,
              so it isn't double-messaged here (FEN-269). */}
          {/* Overflow disclosure (FEN-326 / AC-6): on a compact viewport the
              secondary actions collapse behind this single "More" trigger so the
              bar never eats a permanent strip. On desktop the trigger is
              `display:none` and `.lp-topbar-secondary` flexes inline, so nothing
              regresses (AC-9). The wrapper carries `data-open` for the mobile
              popover and `display:contents` on desktop. */}
          <div className="lp-topbar-menu" ref={menuRef}>
            <button
              type="button"
              ref={menuTriggerRef}
              className="lp-navlink lp-topbar-menu-trigger"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              aria-controls="lp-topbar-secondary"
              aria-label={menuOpen ? t("canvas.menu.close") : t("canvas.menu.open")}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {/* SVG hamburger — U+2630 ☰ renders as tofu on many mobile fonts (AC-3). */}
              <svg
                className="lp-topbar-menu-icon"
                width="16"
                height="12"
                viewBox="0 0 16 12"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect width="16" height="2" rx="1" />
                <rect y="5" width="16" height="2" rx="1" />
                <rect y="10" width="16" height="2" rx="1" />
              </svg>
              <span className="lp-topbar-menu-label">{t("canvas.menu.open")}</span>
            </button>
            <div
              id="lp-topbar-secondary"
              className="lp-topbar-secondary"
              data-open={menuOpen ? "true" : "false"}
              onClick={() => setMenuOpen(false)}
            >
              {/* §0 — Studio (owner-only, AC3.6): visible seulement si isCanvasOwner.
                  Un viewer ou mod non-owner ne voit aucune entrée studio (R1). */}
              {isCanvasOwner && (
                <>
                  <div className="lp-menu-section">
                    <button
                      type="button"
                      className="lp-navlink lp-menu-row"
                      onClick={() => {
                        setMenuOpen(false);
                        setStudioOpen(true);
                      }}
                    >
                      {t("canvas.menu.studio")}
                    </button>
                  </div>
                  <hr className="lp-menu-divider" />
                </>
              )}
              {/* §1 — Navigation: howto guide. */}
              <div className="lp-menu-section">
                {/* "Comment ça marche" — always reachable; re-opens the G2 Temps 2
                    (Outils) panel regardless of gate state (FEN-584 §3 réaffichable). */}
                <button type="button" className="lp-navlink lp-menu-row" onClick={openHowto}>
                  {t("canvas.onboarding.howto")}
                </button>
              </div>
              <hr className="lp-menu-divider" />
              {/* §2 — Actions: shortcuts, share, sound. */}
              <div className="lp-menu-section">
                {/* Keyboard shortcuts trigger (G8, FEN-616) — AC-D3: renders the
                    i18n label (canvas.shortcuts.open), not a bare "?"; the "?" stays
                    as a decorative glyph before the label (aria-hidden). */}
                <button
                  ref={shortcutsTriggerRef}
                  type="button"
                  className="lp-navlink lp-menu-row lp-shortcuts-trigger"
                  aria-haspopup="dialog"
                  aria-expanded={shortcutsOpen}
                  aria-controls="lp-shortcuts-dialog"
                  aria-label={t("canvas.shortcuts.open")}
                  onClick={() => setShortcutsOpen((o) => !o)}
                >
                  <span aria-hidden="true">?</span>
                  {t("canvas.shortcuts.open")}
                </button>
                {/* "Partager" — copy the public /c/:slug link. Rendered unconditionally
                    (no auth gate) so anonymous viewers can share too (FEN-304 AC2). */}
                <ShareButton slug={slug} />
                {/* G4 (FEN-639): sound toggle — AC-D4: variant="row" renders a
                    labelled switch row instead of the floating icon; data-chrome
                    preserved (excluded from OBS capture). */}
                <SoundToggle
                  on={soundEnabled}
                  onChange={() => setSoundEnabled(!soundEnabled)}
                  blocked={autoplayBlocked}
                  variant="row"
                />
              </div>
              <hr className="lp-menu-divider" />
              {/* §3 — Langue. */}
              <div className="lp-menu-section">
                <LanguageSwitcher />
              </div>
              <hr className="lp-menu-divider" />
              {/* §4 — Compte. Identity / auth control. On desktop the secondary
                  group is `display:contents`, so the auth control still renders
                  inline as the last bar item exactly as before (AC-D2 / AC-9). */}
              <div className="lp-menu-section">
                <AuthButton />
              </div>
            </div>
          </div>
        </div>

      {/* ---- Desktop R2 topbar zones (FEN-1052) — display:none on mobile ----
          Three zones: left (brand+title+status) · centre (nav) · right
          (utilities+account). The existing mobile structure above stays
          pixel-identical at <1024px; CSS switches which is shown at ≥1024px. */}

      {/* Zone gauche : wordmark + titre fresque + pastille + compteur */}
      <div className="lp-tb-left">
        <Wordmark size="sm" />
        {slug && (
          <>
            <span className="lp-tb-div" aria-hidden="true" />
            <span className="lp-tb-title">{slug}</span>
          </>
        )}
        {canvasDoc?.status === "open" && (
          <span className="lp-tb-open">
            <span aria-hidden="true">● </span>
            {t("canvas.status.open")}
          </span>
        )}
      </div>

      {/* Zone centre : nav primaire */}
      <nav className="lp-tb-center" aria-label={t("nav.primary")}>
        {/* Studio (owner-only, AC3.4): desktop trigger opening the right-side drawer.
            .lp-tb-center is display:none below 1024px so this button is never
            visible on mobile — the mobile path remains the ≡ burger → secondary menu. */}
        {isCanvasOwner && (
          <button
            type="button"
            className="lp-navlink lp-tb-nav-link"
            aria-haspopup="dialog"
            aria-expanded={studioOpen}
            onClick={() => setStudioOpen(true)}
          >
            {t("canvas.menu.studio")}
          </button>
        )}
        <button type="button" className="lp-navlink lp-tb-nav-link" onClick={openHowto}>
          {t("canvas.onboarding.howto")}
        </button>
        <button
          ref={shortcutsDesktopTriggerRef}
          type="button"
          className="lp-navlink lp-tb-nav-link lp-shortcuts-trigger"
          aria-haspopup="dialog"
          aria-expanded={shortcutsOpen}
          aria-controls="lp-shortcuts-dialog"
          onClick={() => setShortcutsOpen((o) => !o)}
        >
          {t("canvas.shortcuts.open")}
        </button>
      </nav>

      {/* Zone droite : utilitaires + compte */}
      <div className="lp-tb-right">
        <SoundToggle
          on={soundEnabled}
          onChange={() => setSoundEnabled(!soundEnabled)}
          blocked={autoplayBlocked}
        />
        <ShareButton slug={slug} />
        <LanguageSwitcher />
        <AuthButton />
      </div>
      </div>

      {/* FEN-1490: HUD migré vers bulle flottante desktop (remplace panneau latéral).
          Mobile bottom sheet strictement inchangé (AC1). Desktop: position:fixed
          centrée en bas, flotte au-dessus du canvas, canvas non redimensionné (AC6).
          dataset expose data-pose/staged/auth/mode/panel-open pour le CSS. */}
      <BottomSheet
        open={effectivePanelOpen}
        onClose={togglePanel}
        presentation="modeless"
        desktop="bubble"
        showHandle={showHandle}
        dragDismiss
        dismissThreshold={0.25}
        ariaLabel={t("canvas.panel.label")}
        className="lp-hud"
        dataset={{
          pose: drawing || count > 0 ? "on" : "off",
          staged: count > 0 ? "yes" : "no",
          auth: convexAuthed ? "in" : "out",
          mode: hudMode,
          "panel-open": panelOpen ? "true" : "false",
        }}
      >
        {/* ── Bubble header (desktop uniquement, AC2/AC4/AC5/AC9) ─────────────
            Toujours visible : état compact ET plein. Sur mobile: display:none.
            Disposition: barre raccourcis + ✕/↑ (row 1) · jauge X/X+timer (row 2).
            onClick sur le header quand compact (panel-open=false) → openPanel. */}
        <div
          className="lp-bubble-header"
          onClick={panelOpen ? undefined : openPanel}
        >
          {/* Row 1: bouton raccourcis + bouton toggle compact/plein */}
          <div className="lp-bubble-topbar">
            <button
              type="button"
              className="lp-bubble-shortcuts-btn"
              aria-label={t("canvas.shortcuts.open")}
              aria-haspopup="dialog"
              aria-expanded={shortcutsOpen}
              aria-controls="lp-shortcuts-dialog"
              onClick={(e) => { e.stopPropagation(); setShortcutsOpen((o) => !o); }}
            >
              <kbd className="lp-bubble-key" aria-hidden="true">?</kbd>
              <span>{t("canvas.shortcuts.open")}</span>
            </button>
            {/* Show ✕ only when a detail panel is open (palette / pixel-info).
                At rest (gauge only, no detail), the button is hidden; when
                compact (!panelOpen) we still show ↑ to expand. */}
            {(!panelOpen || hudMode !== "none") && (
              <button
                type="button"
                className="lp-bubble-close-btn"
                aria-label={panelOpen ? t("canvas.panel.close") : t("canvas.panel.open")}
                onClick={(e) => { e.stopPropagation(); togglePanel(); }}
              >
                <span aria-hidden="true">{panelOpen ? "✕" : "↑"}</span>
              </button>
            )}
          </div>
          {/* Row 2: jauge héroïque X/X + timer (AC9 — desktop uniquement).
              Visible dans les deux états (compact + plein). */}
          {effectiveGauge && (
            <div className="lp-hero-gauge-wrap">
              <HeroGauge
                charges={effectiveGauge.charges}
                max={effectiveGauge.max}
                cooldownUntil={effectiveGauge.cooldownUntil}
              />
            </div>
          )}
        </div>

        {/* ── Bubble body (contenu repliable, AC5) ────────────────────────────
            Mobile: display:contents → enfants en flux direct du HUD (AC1).
            Desktop bubble: flex-column, s'effondre via max-height/opacity quand
            data-panel-open="false" (état compact). */}
        <div className="lp-bubble-body">
          <h1>{t("app.title")}</h1>

          {/* HeroGauge pour les variantes desktop non-bubble (sidebar, etc.).
              Masqué dans la bulle par CSS — il vit dans le header pour la bulle. */}
          {effectiveGauge && (
            <div className="lp-hero-gauge-wrap">
              <HeroGauge
                charges={effectiveGauge.charges}
                max={effectiveGauge.max}
                cooldownUntil={effectiveGauge.cooldownUntil}
              />
            </div>
          )}

          {/* Lot D — claim signal (FEN-116 · Option A FEN-1311 · B1 FEN-1318): no green box,
              single coral CTA full-width. No live role (FEN-140 #2): standing affordance. */}
          {pendingTiers > 0 && (
            <div className="lp-claim">
              <Button
                variant="primary"
                className="lp-claim-btn"
                onClick={pendingTiers > 1 ? claimAll : claimNext}
              >
                {pendingTiers > 1
                  ? t("canvas.claim.all", { count: pendingTiers })
                  : t("canvas.claim.actionOne")}
              </Button>
            </div>
          )}

          {/* Non-connected: the dock's standing primary action is the Twitch CTA.
              FEN-924: goes directly to OAuth without the value modal.
              FEN-957: suppress while auth is still resolving for a browser that
              "was authed" (authPending) so the CTA does not flash then disappear.
              FEN-1366: hidden when pixel-info is open — the pixelInfo block owns
              its own connect CTA below, so showing both would duplicate the button. */}
          {!convexAuthed && !authPending && !pixelInfo && (
            <Button
              className="lp-cta lp-auth__twitch"
              icon={<TwitchGlyph size={20} />}
              onClick={handleDirectSignIn}
            >
              {t("auth.signIn")}
            </Button>
          )}

          {/* Pixel-info panel (FEN-249 / FEN-755): a click opens this read-only
              panel with the cell's coordinates, colour swatch, who placed it,
              avatar, and when. "Dessiner" starts selection; "Confirmer" commits.
              An empty cell shows "aucun auteur" (not an error). Read-only, so it
              stays available to anonymous viewers — but "Dessiner" is swapped for
              the connect CTA when signed out (AC-3). */}
          {pixelInfo && (
            <div
              className="lp-pixelinfo"
              role="dialog"
              aria-label={t("canvas.pixelInfo.title")}
              data-author-state={pixelInfo.authorState}
            >
              {/* Header row: colour swatch + coordinates */}
              <div className="lp-pixelinfo-header">
                {pixelInfo.color > 0 && (
                  <span
                    className="lp-pixelinfo-swatch"
                    style={{ background: PALETTE_HEX[pixelInfo.color] ?? "#ffffff" }}
                    aria-hidden="true"
                  />
                )}
                <p className="lp-pixelinfo-coords">
                  {t("canvas.pixelInfo.coords", { x: pixelInfo.x, y: pixelInfo.y })}
                </p>
              </div>
              {/* Author row: avatar (known only) + login or anon label */}
              <div className="lp-pixelinfo-author">
                {pixelInfo.authorState === "known" && pixelInfo.avatarUrl && (
                  <img
                    src={pixelInfo.avatarUrl}
                    alt=""
                    aria-hidden="true"
                    className="lp-pixelinfo-avatar"
                    width={24}
                    height={24}
                  />
                )}
                <p className="lp-pixelinfo-author-text">
                  {pixelInfo.authorState !== "unknown" && (
                    <>
                      <span className="lp-pixelinfo-author-label">{t("canvas.pixelInfo.authorLabel")}</span>{" "}
                    </>
                  )}
                  <span className="lp-pixelinfo-author-value">{pixelInfoAuthorText}</span>
                </p>
              </div>
              {/* Placement date/time — shown for any occupied cell (known or anon) */}
              {pixelInfoDateText && (
                <p className="lp-pixelinfo-date">{pixelInfoDateText}</p>
              )}
              {/* AC-B6: hide Dessiner + Fermer while a mod action awaits confirmation. */}
              {modArmed === null && (
                <div className="lp-pixelinfo-actions">
                  {convexAuthed ? (
                    <Button variant="primary" className="lp-pixelinfo-draw" onClick={drawFromInspect}>
                      {t("canvas.draw")}
                    </Button>
                  ) : !authPending ? (
                    <Button
                      className="lp-pixelinfo-draw lp-auth__twitch"
                      icon={<TwitchGlyph size={20} />}
                      onClick={handleDirectSignIn}
                    >
                      {t("auth.signIn")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" className="lp-cancel-btn lp-pixelinfo-close" onClick={closeInspect}>
                    {t("canvas.pixelInfo.close")}
                  </Button>
                </div>
              )}

              {canModerate && !pixelInfo.isEmpty && (
                <div className="lp-pixelinfo-mod" role="group" aria-label={t("canvas.mod.title")}>
                  <span className="lp-pixelinfo-mod-title">{t("canvas.mod.title")}</span>
                  {modArmed === null ? (
                    <div className="lp-pixelinfo-mod-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="lp-pixelinfo-mod-danger"
                        onClick={() => setModArmed("deletePixel")}
                      >
                        {t("canvas.mod.deletePixel")}
                      </Button>
                      {pixelInfo.authorState === "known" && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="lp-pixelinfo-mod-danger"
                            onClick={() => setModArmed("deleteGroup")}
                          >
                            {t("canvas.mod.deleteGroup")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="lp-pixelinfo-mod-danger"
                            onClick={() => setModArmed("ban")}
                          >
                            {t("canvas.mod.ban")}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="lp-pixelinfo-mod-confirm" role="alertdialog" aria-label={t("canvas.mod.title")}>
                      <p className="lp-pixelinfo-mod-prompt">
                        {modArmed === "deletePixel"
                          ? t("canvas.mod.confirmDeletePixel")
                          : modArmed === "deleteGroup"
                            ? t("canvas.mod.confirmDeleteGroup")
                            : pixelInfo.authorLogin
                              ? t("canvas.mod.confirmBan", { login: pixelInfo.authorLogin })
                              : t("canvas.mod.confirmBanAnon")}
                      </p>
                      <div className="lp-pixelinfo-mod-confirm-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={modPending}
                          onClick={() => void runModAction(modArmed)}
                        >
                          {modPending ? t("canvas.mod.working") : t("canvas.mod.confirm")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={modPending}
                          onClick={() => setModArmed(null)}
                        >
                          {t("canvas.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Row 4 (AC spec disposition): palette + Pipette/Gomme + bouton Placer.
              Mobile: sheet unfolds in pose mode. Desktop bubble: always rendered,
              hidden by CSS when data-pose="off" (AC3/AC-4/AC-5). */}
          {convexAuthed && (
            <div className="lp-pose">
              <div className="lp-pose-palette">
                <ColorSelector
                  colors={palette}
                  value={erasing ? ERASER_ID : String(color)}
                  onChange={(id) => {
                    if (id === ERASER_ID) {
                      setErasing(true);
                    } else {
                      setColor(Number(id));
                      setErasing(false);
                    }
                  }}
                  eraser={drawing ? eraserItem : undefined}
                  ariaLabel={t("canvas.palette")}
                  compact
                />
              </div>

              <div className="lp-cta-row">
                <Button
                  variant="primary"
                  size="lg"
                  className="lp-cta-poser"
                  loading={submitting}
                  disabled={count > 0 ? sel.isLocked || !placeState.canPlace : !placeState.canPlace}
                  onClick={count > 0 ? validate : inspect ? drawFromInspect : startPose}
                >
                  {submitting
                    ? t("canvas.validate", { count: placedCount })
                    : count > 0
                      ? t("canvas.validate", { count })
                      : placeState.canPlace
                        ? t("canvas.placeHere")
                        : t("canvas.poseWait")}
                </Button>
                {(count > 0 || drawing) && (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="lp-cancel-btn"
                    onClick={cancel}
                    aria-label={t("canvas.cancel")}
                    title={t("canvas.cancel")}
                  >
                    <span aria-hidden="true" className="lp-cancel-btn__icon">✕</span>
                    <span className="lp-cancel-btn__label">{t("canvas.cancel")}</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

      </BottomSheet>

      {/* FEN-788: lp-pose-fab ("Poser ici") superseded by tap-to-place (tap on
          canvas grid = pose directe). Removed — not rendered on mobile. */}

      {/* Canvas area overlay (FEN-1484): anchors the zoom controls absolutely
          inside the available canvas space (below the topbar). This wrapper is
          position:fixed top:--lp-topbar-h so zoom controls are always visible
          regardless of header height. pointer-events:none on the wrapper lets
          canvas interactions through; the zoom controls opt back in. */}
      <div className="lp-canvas-area">
      {/* ZoomControls (R2 FEN-370 / FEN-388): explicit +/−/⊡ so pinch-to-zoom is
          not the ONLY path (pinch with touch-action:none is not discoverable,
          Paradox of the Active User). Absolute inside .lp-canvas-area (FEN-1484).
          The ⊡ button fits the whole fresco; it shows active (aria-pressed) at
          the fit floor. Desktop: bottom-left (override in canvas.css). */}
      <div className="lp-zoom-controls" role="group" aria-label={t("canvas.zoom.label")}>
        <button
          ref={zoomInRef}
          type="button"
          className="lp-zoom-btn"
          aria-label={t("canvas.zoom.in")}
          disabled={!canZoomIn}
          aria-disabled={!canZoomIn || undefined}
          onClick={() => rendererRef.current?.zoomIn()}
        >
          +
        </button>
        <span aria-hidden="true" className="lp-zoom-divider" />
        <button
          ref={zoomOutRef}
          type="button"
          className="lp-zoom-btn"
          aria-label={t("canvas.zoom.out")}
          disabled={!canZoomOut}
          aria-disabled={!canZoomOut || undefined}
          onClick={() => rendererRef.current?.zoomOut()}
        >
          −
        </button>
        <span aria-hidden="true" className="lp-zoom-divider" />
        <button
          ref={fitRef}
          type="button"
          className="lp-zoom-btn"
          aria-label={t("canvas.zoom.fit")}
          aria-pressed={atFit}
          onClick={() => rendererRef.current?.fitToScreen()}
        >
          {/* SVG replaces ⊡ (U+22A1) which renders as tofu when the font lacks it. */}
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
          >
            <polyline points="4,1 1,1 1,4" />
            <polyline points="10,1 13,1 13,4" />
            <polyline points="13,10 13,13 10,13" />
            <polyline points="4,13 1,13 1,10" />
          </svg>
        </button>
      </div>
      </div>

      {/* Feedback via the Arcade Toast (icon + label, never colour alone). The
          host owns placement + auto-dismiss (the lp-toast-host fixes it bottom-
          centre); Toast carries its own role (status, or alert when kind=error).
          A posed/updated batch is a success; cooldown/cap are informational; any
          refusal is an error. An explicit close button (onClose) sits alongside
          the auto-dismiss so the toast is dismissible on demand (FEN-329 / AC-11)
          — useful when it briefly covers a cell the viewer wants to act on. */}
      {toast && (
        <div className="lp-toast-host">
          <Toast
            kind={
              toast.kind === "placed" || toast.kind === "success"
                ? "success"
                : toast.kind === "cooldown" || toast.kind === "cap"
                  ? "info"
                  : "error"
            }
            title={t(toast.messageKey as MessageKey, toast.params)}
            onClose={() => setToast(null)}
            closeLabel={t("canvas.toast.close")}
          />

        </div>
      )}

      {/* Pre-OAuth value modal (FEN-580 / G1): single intermediate screen before
          the Twitch redirect. Rendered outside the HUD so it is never clipped
          by the dock's overflow:hidden and can trap focus independently. */}
      <AuthModal
        open={modalData !== null}
        callbackURL={modalData?.callbackURL ?? "/"}
        errorCallbackURL={modalData?.errorCallbackURL}
        streamer={modalData?.streamer ?? null}
        triggerEl={modalTriggerRef.current}
        onDismiss={dismissModal}
        onBeforeRedirect={persistReturnTrip}
      />


      {/* Keyboard shortcuts cheat-sheet (G8, FEN-616): a non-blocking popover
          listing all shortcuts with FR/EN copy. Opens via the "?" topbar button
          or by pressing the ? key; closes via Esc, click outside, or the same
          button. role="dialog" (non-modal) + aria-labelledby for SR. */}
      {/* S2 (FEN-1174): StudioPanel — mounted only for the canvas owner (AC3.6).
          `studioOpen` is orthogonal to panelOpen + menuOpen (R6). */}
      {isCanvasOwner && (
        <StudioPanel
          open={studioOpen}
          onClose={closeStudio}
          titleId="lp-studio-title"
        >
          <StudioDashboardBody headingId="lp-studio-title" onClose={closeStudio} />
        </StudioPanel>
      )}

      {shortcutsOpen && (
        <div
          ref={shortcutsDialogRef}
          id="lp-shortcuts-dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby="lp-shortcuts-title"
          className="lp-shortcuts"
          onPointerDown={(e) => e.stopPropagation()} // don't let outside-click handler close via this
        >
          <div className="lp-shortcuts-inner">
            <h2 id="lp-shortcuts-title" className="lp-shortcuts-title">
              {t("canvas.shortcuts.title")}
            </h2>
            <ul className="lp-shortcuts-list" aria-label={t("canvas.shortcuts.title")}>
              <li>{t("canvas.shortcuts.esc")}</li>
              <li>{t("canvas.shortcuts.enter")}</li>
              <li>{t("canvas.shortcuts.e")}</li>
              <li>{t("canvas.shortcuts.i")}</li>
              <li>{t("canvas.shortcuts.g")}</li>
              <li>{t("canvas.shortcuts.m")}</li>
              <li>{t("canvas.shortcuts.space")}</li>
            </ul>
            <p className="lp-shortcuts-tip">{t("canvas.shortcuts.tip")}</p>
            <button
              type="button"
              className="lp-btn lp-shortcuts-close"
              onClick={() => {
                setShortcutsOpen(false);
                focusShortcutsTrigger();
              }}
              aria-label={t("canvas.shortcuts.close")}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
