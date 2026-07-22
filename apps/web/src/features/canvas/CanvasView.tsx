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
import { api } from "@canvas/convex/api";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import type { GaugeState } from "@canvas/protocol";
import { authClient, signInWithTwitch } from "../../auth/auth-client.js";
import {
  saveBatch,
  saveReturnIntent,
} from "../../auth/return-trip.js";
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { OptimisticPlacement, type PlacementFeedback } from "./placement.js";
// BatchSelection + EMPTY_COLOR extracted to useBatchPlacement.
import { gateInteraction, canvasCallbackURL, type CanvasInteraction } from "./authGate.js";
import { inertTierSource, type TierSource } from "./tierClaim.js";
import { derivePlaceState, resolvePermission, type CanPlaceReason, type ConnectionState } from "./placeState.js";
// deriveCooldownView + armingCapacity extracted to useBatchPlacement.
import {
  derivePixelInfo,
  inertPixelAuthorSource,
  type PixelAuthorSource,
} from "./pixelInfo.js";
import { inertModerationSource, type ModerationSource } from "./moderationSource.js";
import { gatewayWsUrl } from "./gateway.js";
// Arcade design system (Lot 0 — FEN-268): one definition per component, token-
// only styling. This screen is a COMPOSITION of these, never a local restyle.
import {
  BottomSheet,
  Button,
  ColorSelector,
  Gauge,
  HeroGauge,
  TwitchGlyph,
  StateScreen,
  StateArt,
  OfflineBanner,
  type EraserItem,
  type PaletteColor,
} from "../../ui/index.js";
import { FrescoCanvas } from "./FrescoCanvas.js";
// cooldownRingPercent extracted to useBatchPlacement.
import { computeShowHandle } from "./panelHandle.js";
// escapeAction extracted to useCanvasKeyboard.
import { useSoundEngine } from "./useSoundEngine.js";
import { CanvasChrome, ShortcutItem, TOAST_MS, type ToastState, type ModalData } from "./CanvasChrome.js";
import { PixelInfoPanel } from "./PixelInfoPanel.js";
import { usePixelInspect } from "./usePixelInspect.js";
import { applySpaceHold, applyHoverSpacePaint } from "./spaceHoldPaint.js";
import { applyEyedropperToggle } from "./eyedropper.js";
import { useCanvasKeyboard } from "./useCanvasKeyboard.js";
import { useBatchPlacement } from "./useBatchPlacement.js";
import { useProfileSheet } from "../profile/profileSheetStore.js";
import "./canvas.css";

const DEFAULT_COLOR = 5; // red — a visible default pose colour
const ERASER_ID = "__eraser__"; // sentinel id for the palette eraser item (FEN-418 A7)

/**
 * Convex queries referenced by name (`module:function`) — decoupled from the
 * generated api, the same pattern GalleryPage uses. They feed the unified
 * "puis-je poser ?" indicator (Lot E, [FEN-117]):
 *   - `getCanvasBySlug` → the canvas doc (status + event window) and its id
 *   - `canPlace` → the placement permission contract `{ allowed, reason? }`
 * Both are skipped (no network) when there is no slug to resolve.
 */
const getCanvasBySlugRef = api.canvases.getCanvasBySlug;
const canPlaceRef = api.canvases.canPlace;

/** Map the WS transport status onto the state machine's connection vocabulary. */
function toConnectionState(status: ConnectionStatus): ConnectionState {
  return status === "open" ? "open" : status === "connecting" ? "connecting" : "offline";
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
  /**
   * Per-cell author source for the pixel-info panel (FEN-249). Defaults to
   * {@link inertPixelAuthorSource} (resolves to `null` → "author unavailable")
   * until the viewer-facing backend attribution query lands — see pixelInfo.ts
   * and the FEN-249 backend dependency.
   */
  pixelAuthorSource?: PixelAuthorSource;
  /**
   * Whether the CURRENT viewer may moderate this canvas (FEN-754 §8.2). Drives
   * whether the pixel-info panel exposes the two inline mod actions. Defaults to
   * `false` (no mod UI); {@link CanvasViewLive} feeds the live `moderation.canModerate`.
   */
  canModerate?: boolean;
  /**
   * Source for the two pixel-click moderation actions (FEN-754 §8.2: erase group /
   * ban author — FEN-1962). Defaults to {@link inertModerationSource};
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
  const { openProfile } = useProfileSheet();
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
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  // current tool, mirrored into refs so the renderer's tap callback (bound once)
  // always reads the latest value without re-binding.
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [erasing, setErasing] = useState(false);
  const colorRef = useRef(color);
  const erasingRef = useRef(erasing);
  colorRef.current = color;
  erasingRef.current = erasing;

  // S3 (FEN-1887): eyedropper mode — pressing I enters a persistent pick mode
  // where the next canvas tap adopts the clicked pixel's colour. Mirrored into
  // a ref so the bound-once onTap callback always reads the live state.
  const [eyedropperMode, setEyedropperMode] = useState(false);
  const eyedropperModeRef = useRef(false);
  eyedropperModeRef.current = eyedropperMode;

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
  const pixelAuthorSourceRef = useRef<PixelAuthorSource>(pixelAuthorSource);
  pixelAuthorSourceRef.current = pixelAuthorSource;
  // Read the moderation source through a ref so the bound handler always
  // sees the latest injected bridge.
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
  const [toast, setToast] = useState<ToastState | null>(null);
  const [announce, setAnnounce] = useState(""); // polite SR readout of the keyboard cursor (U3)
  // Topbar reflow (FEN-283): the topbar can change height (e.g. it wraps a second
  // row on a narrow viewport). The floating status pill and the dock in landscape
  // use `--lp-topbar-h` to clear the bar's real bottom edge.
  const topbarRef = useRef<HTMLDivElement>(null);

  // Topbar overflow menu (FEN-326 / AC-6 / FEN-1660): on a compact viewport the
  // secondary actions collapse behind a single burger trigger that opens a bottom
  // sheet (FEN-1660). BottomSheet modal handles Escape/backdrop/drag dismiss.
  const [menuOpen, setMenuOpen] = useState(false);
  // FEN-1884: keyboard shortcuts bottom sheet — trigger managed inside CanvasChrome.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // S2 (FEN-1174): Studio panel open/close — orthogonal to menuOpen + panelOpen (R6).
  // Only ever true when isCanvasOwner===true; mounting StudioPanel is also guarded.
  const [studioOpen, setStudioOpen] = useState(false);
  const closeStudio = useCallback(() => setStudioOpen(false), []);

  // G4 (FEN-639): sound engine — WebAudio synthesis, localStorage persistence,
  // autoplay-policy handling. playPoseRef/playGaugeFullRef let the bound-once
  // net callbacks always invoke the current engine without re-running the effect.
  const { soundEnabled, setSoundEnabled, autoplayBlocked, playPose, playGaugeFull } =
    useSoundEngine();
  const playPoseRef = useRef(playPose);
  playPoseRef.current = playPose;
  const playGaugeFullRef = useRef(playGaugeFull);
  playGaugeFullRef.current = playGaugeFull;

  // FEN-1880: keyboard shortcuts are desktop-only — hide when no fine pointer
  // (pointer: fine = mouse/trackpad; coarse = touch/stylus-only tablet).
  const hasFinePointer = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches,
    [],
  );

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

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".lp-hud .lp-panel-handle")?.focus()
    );
  }, [setPanelOpen]);

  // S3 eyedropper one-shot (FEN-1732): unified pick for both canvas-focused (I key
  // handled by renderer) and document-level paths. Cell = hoverRef (mouse or keyboard
  // cursor — onHover and onCursorMove both write it). Never silent: empty/no-hover
  // announces "pixel vide" via aria-live.
  const pickColor = useCallback(() => {
    const cell = hoverRef.current;
    const c = cell ? (rendererRef.current?.colorAt(cell.x, cell.y) ?? 0) : 0;
    if (c > 0) {
      setColor(c);
      setErasing(false);
      openPanel();
      setAnnounce(tRef.current("canvas.eyedropper.picked", { index: c }));
    } else {
      setAnnounce(tRef.current("canvas.eyedropper.empty"));
    }
  }, [openPanel]);

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
      // Apply bottom inset only when the HUD is a genuine fixed bottom overlay
      // (mobile bottom sheet: position:fixed, bottom:0). A centered card sheet
      // (BottomSheet ≥640px: bottom:auto) or a landscape rail should not eat
      // into the canvas viewport vertically (AC6 FEN-1675).
      const cs = window.getComputedStyle(el);
      const isBottomDock = cs.position === "fixed" && cs.bottom === "0px";
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
  // Ref so the mount effect reads the resolved canvasId at connect time without
  // being re-triggered by it (the effect is intentionally keyed on slug only).
  const canvasIdRef = useRef<string | null>(canvasId);
  canvasIdRef.current = canvasId;
  const permissionResult = useQuery(canPlaceRef, canvasId ? { canvasId } : "skip");
  // Map slug + live canPlace → the unified indicator's permission input. The
  // default canvas (slug null) has no canPlace contract and is implicitly open,
  // so this yields `{ allowed: true }` (gateway-authoritative) instead of the
  // `undefined` that would pin it at "loading" forever — see resolvePermission
  // (FEN-277). A slugged canvas forwards the live result (undefined → loading).
  const permission = resolvePermission(slug, permissionResult);

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
      const decision = gateInteraction(interaction, authedRef.current, {
        slug,
        currentPath: typeof window !== "undefined" ? window.location.pathname : "/",
      });
      if (decision.kind === "consent") {
        if (modalDataRef.current === null) {
          // Capture triggering element for focus return (E10 / AC7).
          modalTriggerRef.current =
            typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
          setModalData({
            callbackURL: decision.callbackURL,
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

  // Stable closeInspect wrapper so useBatchPlacement can be called before
  // usePixelInspect (which provides the real closeInspect). The hook's cancel
  // callback delegates through this ref, wired after usePixelInspect runs.
  const _closeInspectRef = useRef<() => void>(() => {});
  const _closeInspectWrap = useCallback(() => _closeInspectRef.current(), []);

  // Batch-selection, tier-claim, cooldown (FEN-1952).
  const {
    selectionRef,
    canPlaceNowRef,
    canArmNowRef,
    onCooldownRef,
    cooldownSecondsRef,
    blockedMsgRef,
    submitting,
    placedCount,
    count,
    pendingTiers,
    effectiveGauge,
    cooldownView,
    effOnCooldown,
    ringSeconds,
    ringPercent,
    stageCell,
    deselectCell,
    validate,
    startPose,
    cancel,
    claimNext,
    claimAll,
    replayClaims,
  } = useBatchPlacement({
    gauge,
    tierSource,
    slug,
    convexAuthed,
    requireAccount,
    showToast: showToast as (f: { kind: string; messageKey: string; params?: Record<string, string | number> }) => void,
    netRef,
    rendererRef,
    hoverRef,
    placementRef,
    closeInspect: _closeInspectWrap,
    openPanel,
    setDrawing,
    drawingRef,
    erasingRef,
    colorRef,
    playGaugeFullRef,
  });

  // onStartDraw: called by usePixelInspect's drawFromInspect to transfer the
  // inspected cell into draw mode without staging it (D-A, FEN-797).
  // Defined after useBatchPlacement so selectionRef is available.
  const onStartDraw = useCallback((cell: { x: number; y: number }) => {
    setDrawing(true);
    hoverRef.current = cell;
    rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
  }, [selectionRef]);

  const {
    inspect,
    inspectAuthor,
    modArmed,
    setModArmed,
    modPending,
    closeInspect,
    openInspect,
    drawFromInspect,
    runModAction,
  } = usePixelInspect({
    pixelAuthorSourceRef,
    moderationSourceRef,
    requireAccount,
    openPanel,
    rendererRef,
    showToast,
    drawing,
    onStartDraw,
  });

  // Wire the actual closeInspect into the cancel / keyboard wrapper.
  _closeInspectRef.current = closeInspect;

  // FEN-924: dock CTA for anonymous users bypasses the value modal and goes
  // directly to Twitch OAuth. No draw intent, no staged batch → nothing to
  // persist before the redirect.
  const handleDirectSignIn = useCallback(() => {
    const callbackURL = canvasCallbackURL(
      slug,
      typeof window !== "undefined" ? window.location.pathname : "/",
    );
    void signInWithTwitch(callbackURL);
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
  }, [selectionRef, slug]);

  // FEN-1783: HUD BottomSheet onClose — in active modes (inspect / draw) the
  // X button (desktop handle) must close the MODE while keeping the gauge
  // visible. After the mode exits hasActiveMode=false, so effectivePanelOpen =
  // panelOpen || !false = true — the gauge stays on screen. Only falls back to
  // togglePanel for the idle-state drag-dismiss path (no mode, no handle shown).
  const onHudClose = useCallback(() => {
    if (inspect) { closeInspect(); return; }
    if (drawingRef.current) { cancel(); return; }
    togglePanel();
  }, [inspect, closeInspect, cancel, togglePanel]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

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

  // FEN-1901: enter draw mode via Space — inspect path transfers the inspected cell,
  // gauge-only path opens placement directly (same as the dock's "Poser ici" CTA).
  const enterDrawMode = useCallback(() => {
    if (inspect) drawFromInspect();
    else startPose();
  }, [inspect, drawFromInspect, startPose]);

  // FEN-2038: unified eyedropper toggle.
  // OFF→ON: arm eyedropper + ensure draw mode + ensure palette visible.
  // ON→OFF: disarm eyedropper only — drawing mode is intentionally preserved (A2).
  const toggleEyedropper = useCallback(() => {
    applyEyedropperToggle(eyedropperModeRef.current, drawingRef.current, {
      setEyedropperMode,
      enterDrawMode,
      openPanel,
    });
  }, [enterDrawMode, openPanel]);
  // Kept in a ref so the renderer callback (built once per slug) always calls the
  // latest version without triggering a renderer teardown on dep change.
  const toggleEyedropperRef = useRef(toggleEyedropper);
  toggleEyedropperRef.current = toggleEyedropper;

  // G8 (FEN-616 / FEN-1888): global keyboard shortcuts + Space continuous paint.
  const { spacePaintingRef } = useCanvasKeyboard({
    eyedropperModeRef,
    drawingRef,
    hoverRef,
    rendererRef,
    inspect,
    closeInspect,
    cancel,
    stageCell,
    setErasing,
    setEyedropperMode,
    enterDrawMode,
    toggleEyedropper,
  });

  // Mount: build renderer + net client, connect. Teardown on unmount.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const renderer = new CanvasRenderer(
      el,
      {
        onTap: (x, y, pointerType) => {
          // FEN-1887: eyedropper mode — clicking a pixel adopts its colour.
          // Takes priority over draw/inspect so the tap is never also staged.
          if (eyedropperModeRef.current) {
            hoverRef.current = { x, y };
            pickColor();
            setEyedropperMode(false);
            return;
          }
          // In draw mode → stage the cell (the prior selection behaviour;
          // stageCell prevents staging when blocked and explains why).
          if (drawingRef.current) {
            // FEN-1578: desktop (mouse/pen) left-click = select-only, never toggle.
            // Touch keeps the existing toggle so mobile UX is unchanged.
            const isFinePtrInteraction = pointerType === "mouse" || pointerType === "pen";
            stageCell(x, y, { onlyAdd: isFinePtrInteraction });
            return;
          }
          // FEN-797: all taps (touch and mouse/pen) open the pixel-info panel.
          // "Dessiner" is the explicit gate to draw mode — never enter it on tap.
          openInspect(x, y);
        },
        // FEN-1578: right-click on desktop = deselect the clicked cell.
        onRightTap: (x, y) => {
          if (drawingRef.current) deselectCell(x, y);
        },
        // FEN-1578: right-drag = continuous deselect (no pan). Each cell the
        // pointer crosses while holding the right button is removed from the batch.
        onRightHover: (cell) => {
          if (drawingRef.current && cell) deselectCell(cell.x, cell.y);
        },
        // FEN-1734: Space held → arm drag-paint flag + stage hover cell immediately.
        // Called by the renderer BEFORE ensureCursor runs, so hoverRef still holds
        // the real mouse position (not the fallback viewport-centre cursor).
        onSpaceHold: (held) => {
          applySpaceHold(held, { spacePaintingRef, drawingRef, hoverRef, stageCell });
        },
        // FEN-788: long-press on touch = inspect (resolves tap=pose vs tap=inspect
        // collision). Reuses existing inspectedCell marching-ants frame.
        onLongPress: (x, y) => {
          openInspect(x, y);
        },
        onHover: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
          applyHoverSpacePaint(cell, { spacePaintingRef, drawingRef, stageCell });
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
        onEyedropper: () => toggleEyedropperRef.current(),
        // onGridToggle: renderer handles gridEnabled internally; no React state needed.
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
      url: gatewayWsUrl(slug, canvasIdRef.current ?? undefined),
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
              onPlaced: () => { /* server-confirmed placement */ },
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
        onDimsChanged: (w, h) => {
          renderer.resizeTo(w, h);
          // FEN-1821: keep placement bounds in sync so the WS path also unblocks.
          placementRef.current?.setDims(w, h);
        },
        onReconnected: () => {
          const q = placementRef.current?.resendQueue() ?? [];
          for (const m of q) netRef.current?.place(m);
          // Replay any optimistically-encashed-but-unconfirmed tiers. The server
          // applies each `tierIndex` at most once, so this is safe to repeat.
          replayClaims();
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
      // FEN-1616: the gauge is per-canvas. Clear it when the slug changes so the
      // previous canvas's réserve doesn't linger while the new socket's first
      // `gauge` frame is in flight (placeState treats `null` as the "La fresque
      // arrive…" loading state, exactly the right transient here). The durable fix
      // is the per-(canvas,user) Redis key + per-canvas bonus resolve on the
      // gateway; this reset just removes the cross-canvas flash on navigation.
      setGauge(null);
    };
    // `convexAuthed` is intentionally NOT a dep: re-auth on auth flips is owned by a
    // separate effect (keyed on convexAuthed) so the renderer/socket is built once
    // per slug, not torn down and rebuilt on every login state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, showToast, stageCell, deselectCell, validate, cancel, openInspect]);

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

  // FEN-1821: update placement bounds immediately when Convex reactive dims change.
  // This covers the race window where the user sees new dims (Convex reactive, instant)
  // before the `dimsChanged` WS frame arrives (notifyGatewayResize fires with a delay).
  // `placementRef.current` may not exist yet on first render (initialized in onWelcome),
  // but from the second render onward it is always set, which is the relevant case.
  useEffect(() => {
    if (!canvasDoc || !placementRef.current) return;
    placementRef.current.setDims(canvasDoc.width, canvasDoc.height);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasDoc?.width, canvasDoc?.height]);

  // Re-peek the gauge on tab focus or visibility restore (covers long absences
  // where the setInterval was throttled, and accumulation beyond refillIntervalSec).
  useEffect(() => {
    const peek = () => {
      if (gauge !== null && gauge.charges <= 0) netRef.current?.requestGaugePeek();
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

  // The single unified "puis-je poser ?" answer (Lot E, FEN-117): one indicator,
  // yes/no + why + when, recomputed each render (the per-second tick inside
  // useBatchPlacement re-renders so the cooldown countdown stays live). The actual
  // colour/icon is delegated to the UI phase — here we render the text label only (C6).
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
  // Write back to shared refs — consumed by the bound-once renderer tap callback
  // (Lot E "prévenir avant le clic" + Lot F arming window).
  canPlaceNowRef.current = placeState.canPlace;
  blockedMsgRef.current = placeState.messageKey;
  const canArmNow = placeState.canPlace || placeState.kind === "cooldown";
  canArmNowRef.current = canArmNow;
  onCooldownRef.current = placeState.kind === "cooldown";
  cooldownSecondsRef.current = cooldownView?.secondsUntilNext ?? 0;

  // `sel` read for sel.isLocked (CTA disabled check); count comes from useBatchPlacement.
  const sel = selectionRef.current;

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
          primary={{ label: t("state.canvas.cta1"), href: "/gallery" }}
          secondary={{ label: t("state.canvas.cta2"), href: "/" }}
        />
      </div>
    );
  }

  return (
    <div className="lp-app" data-eyedropper-mode={eyedropperMode ? "on" : undefined}>
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
        {/* FEN-1887: eyedropper mode badge — visible when I is active. */}
        {eyedropperMode && (
          <div className="lp-eyedropper-hint" role="status" aria-live="polite">
            {t("canvas.eyedropper.active")}
          </div>
        )}
      </FrescoCanvas>

      <CanvasChrome
        topbarRef={topbarRef}
        zoomInRef={zoomInRef}
        zoomOutRef={zoomOutRef}
        fitRef={fitRef}
        modalTriggerRef={modalTriggerRef}
        slug={slug}
        canvasDocStatus={canvasDoc?.status}
        isCanvasOwner={isCanvasOwner}
        studioOpen={studioOpen}
        onStudioOpen={() => setStudioOpen(true)}
        onStudioClose={closeStudio}
        shortcutsOpen={shortcutsOpen}
        onShortcutsOpen={() => setShortcutsOpen(true)}
        onShortcutsClose={() => setShortcutsOpen(false)}
        drawing={drawing}
        menuOpen={menuOpen}
        onMenuOpen={() => setMenuOpen(true)}
        onMenuClose={() => setMenuOpen(false)}
        soundEnabled={soundEnabled}
        onSoundToggle={() => setSoundEnabled(!soundEnabled)}
        autoplayBlocked={autoplayBlocked}
        onSignIn={handleDirectSignIn}
        convexAuthed={convexAuthed}
        canZoomIn={canZoomIn}
        canZoomOut={canZoomOut}
        atFit={atFit}
        rendererRef={rendererRef}
        toast={toast}
        onToastClose={() => setToast(null)}
        modalData={modalData}
        onModalDismiss={dismissModal}
        onModalBeforeRedirect={persistReturnTrip}
        t={t}
      >

      {/* S3 (FEN-1341): HUD migré vers le socle BottomSheet. Le handle/drag/anim
          sont délégués au socle ; CanvasView ne porte plus que le contenu.
          dataset expose data-pose/staged/auth/mode pour le CSS canvas-spécifique.
          data-open (ouvert/fermé) et data-has-handle sont gérés par le socle. */}
      <BottomSheet
        open={effectivePanelOpen}
        onClose={onHudClose}
        presentation="modeless"
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
        }}
        headerLeft={showHandle && hasFinePointer && drawing ? (
          <ShortcutItem keyLabel={t("canvas.shortcuts.key.enter")} role={t("canvas.shortcuts.role.enter.validate")} />
        ) : undefined}
      >
        <h1>{t("app.title")}</h1>

        {/* G5 — Jauge héroïque (FEN-633): roll-up counter, état plein/charge/vide,
            badge « Plein », compte à rebours A4. Remplace les barres FEN-418 B1/B2
            sur desktop ; les deux visuels sont token-only et lisibles en niveaux
            de gris (AC4). Le HeroGauge porte ses propres sémantiques a11y (AC6):
            role="group" + aria-live sur changements d'état/charge uniquement,
            jamais sur chaque tick de décompte.
            Sur mobile la mini-jauge et le Lot F cooldown restent les indicateurs
            primaires ; le HeroGauge est masqué via CSS (lp-hero-gauge-wrap). */}
        {effectiveGauge && (
          <div className="lp-hero-gauge-wrap">
            <HeroGauge
              charges={effectiveGauge.charges}
              max={effectiveGauge.max}
              cooldownUntil={effectiveGauge.cooldownUntil}
            />
          </div>
        )}

        {/* Fallback reserve bars (mobile / réduit-motion contexts): kept aria-hidden
            since the HeroGauge and StatusPill carry all semantics.
            Shown only when HeroGauge is hidden (CSS gated via .lp-hero-gauge-wrap). */}
        {effectiveGauge && (
          <div className="lp-reserve" aria-hidden="true">
            {effOnCooldown && (
              <Gauge
                mode="cooldown"
                seconds={ringSeconds}
                percent={ringPercent}
                hideCount={true}
              />
            )}
            <Gauge
              mode="ready"
              ready={effectiveGauge.charges}
              max={effectiveGauge.max}
              selection={drawing ? count : 0}
              noLabel={true}
            />
          </div>
        )}

        {/* Lot D — claim signal (FEN-116 · Option A FEN-1311 · B1 FEN-1318): no green box,
            single coral CTA full-width. No live role (FEN-140 #2): standing affordance. */}
        {pendingTiers > 0 && (
          <div className="lp-claim">
            {/* Single coral CTA: "Tout encaisser (N)" on stacked, "Agrandir ma jauge (+1)" on single. */}
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

        {/* Pixel-info panel (FEN-249 / FEN-755): extracted to PixelInfoPanel. */}
        {pixelInfo && (
          <PixelInfoPanel
            pixelInfo={pixelInfo}
            pixelInfoAuthorText={pixelInfoAuthorText}
            pixelInfoDateText={pixelInfoDateText}
            modArmed={modArmed}
            setModArmed={setModArmed}
            modPending={modPending}
            canModerate={canModerate}
            convexAuthed={convexAuthed}
            authPending={authPending || sessionPending}
            drawFromInspect={drawFromInspect}
            runModAction={runModAction}
            onSignIn={handleDirectSignIn}
            openProfile={openProfile}
            t={t}
          />
        )}

        {/* Pose surface (FEN-311): the palette + pose tools. On mobile this is
            the bounded bottom-sheet that unfolds only in pose mode (driven by
            `data-pose` on .lp-hud) so the canvas stays full-screen at rest
            (AC-4/AC-5); on desktop it sits inline in the panel as before
            (AC-16). Rendered only for a connected viewer (AC-3) — there is no
            way into pose mode while signed out, so this never strands a viewer
            mid-batch. */}
        {convexAuthed && (
          <div className="lp-pose">
            {/* Palette (swatches + eraser):
                - Mobile (FEN-788): always visible inline in the barre du bas so
                  colour selection is a direct tap, no "Dessiner" gate needed.
                - Desktop: rendered unconditionally but CSS (.lp-pose-palette)
                  hides it when not in draw mode (data-pose="off").
                AC-3 (FEN-746): heading label removed.
                AC-4 (FEN-746): hint text above the grid.
                AC-1 (FEN-746): compact=true reduces swatch gap. */}
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

            {/* P5 (FEN-1986): empty-state guidance — visible in draw mode with 0 staged
                pixels so the user knows to tap the canvas. Hidden once a pixel is staged. */}
            {drawing && count === 0 && (
              <p className="lp-draw-empty-hint">{t("canvas.drawEmptyHint")}</p>
            )}

            {/* AC-2 (FEN-746): CTA + cancel icon button on the same row.
                Mobile = icon only (✕ square); desktop = icon + "Annuler" label.
                The CTA label + action follow the place-state (FEN-338 / maquette). */}
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

      </BottomSheet>

      </CanvasChrome>
    </div>
  );
}
