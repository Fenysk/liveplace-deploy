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
import { useTranslate } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";
import type { GaugeState } from "@canvas/protocol";
import { AuthButton } from "../../auth/AuthButton.js";
import { authClient, signInWithTwitch } from "../../auth/auth-client.js";
import { LanguageSwitcher } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { ShareButton } from "./ShareButton.js";
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { OptimisticPlacement, type PlacementFeedback } from "./placement.js";
import { BatchSelection, EMPTY_COLOR } from "./selection.js";
import { gateInteraction, type CanvasInteraction } from "./authGate.js";
import { TierClaim, inertTierSource, type TierSource } from "./tierClaim.js";
import { derivePlaceState, resolvePermission, type CanPlaceReason, type ConnectionState } from "./placeState.js";
import { deriveCooldownView, armingCapacity } from "./cooldown.js";
import { deriveModerationNotice, type CanvasLiveness } from "./moderationNotice.js";
import {
  derivePixelInfo,
  inertPixelAuthorSource,
  type PixelAuthor,
  type PixelAuthorSource,
} from "./pixelInfo.js";
import { gatewayWsUrl } from "./gateway.js";
// Arcade design system (Lot 0 — FEN-268): one definition per component, token-
// only styling. This screen is a COMPOSITION of these, never a local restyle.
import {
  Button,
  ColorSelector,
  Gauge,
  StatusPill,
  Toast,
  TwitchGlyph,
  Wordmark,
  type EraserItem,
  type PaletteColor,
} from "../../ui/index.js";
import { FrescoCanvas } from "./FrescoCanvas.js";
import { pillStateForPlace, cooldownRingPercent } from "./canvasArcade.js";
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
  kind: PlacementFeedback["kind"] | "cap";
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
  /**
   * Per-cell author source for the pixel-info panel (FEN-249). Defaults to
   * {@link inertPixelAuthorSource} (resolves to `null` → "author unavailable")
   * until the viewer-facing backend attribution query lands — see pixelInfo.ts
   * and the FEN-249 backend dependency.
   */
  pixelAuthorSource?: PixelAuthorSource;
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
}

/** Default ticket resolver: anonymous read-only (keeps CanvasView Convex-free). */
const anonymousTicket = (): Promise<string | null> => Promise.resolve(null);

export function CanvasView({
  slug = null,
  tierSource = inertTierSource,
  pixelAuthorSource = inertPixelAuthorSource,
  fetchTicket = anonymousTicket,
  convexAuthed = false,
}: CanvasViewProps): React.ReactElement {
  const t = useTranslate();
  // The renderer's keyboard hooks are bound once; read the latest translator
  // through a ref so a mid-session locale switch keeps announcements localized
  // without tearing down the renderer.
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const netRef = useRef<CanvasNetClient | null>(null);
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
  // Pixel-info panel (FEN-249): the cell a click is currently inspecting (coords
  // + author), null when closed. Opening it never stages a cell.
  const [inspect, setInspect] = useState<{ x: number; y: number } | null>(null);
  // Resolved author of the inspected cell: `undefined` while the lookup is in
  // flight, `null` when there is none (empty / anonymous / backend not wired).
  const [inspectAuthor, setInspectAuthor] = useState<PixelAuthor | null | undefined>(undefined);
  // Monotonic token so a slow author lookup can't overwrite a newer inspection.
  const inspectReqRef = useRef(0);
  const pixelAuthorSourceRef = useRef<PixelAuthorSource>(pixelAuthorSource);
  pixelAuthorSourceRef.current = pixelAuthorSource;
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

  // Topbar overflow menu (FEN-326 / AC-6): on a compact viewport the secondary
  // actions (gallery, "how it works", share, language) collapse behind a single
  // "More" disclosure instead of eating a permanent strip. Pure presentation —
  // desktop keeps them inline via CSS (AC-16), the trigger is `display:none`
  // there, so this state only matters on mobile. Closes on Escape / outside
  // click / item activation; focus returns to the trigger on Escape.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
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
  // Ref to the dock element — measured for the bottom inset and ZoomControls position.
  const dockRef = useRef<HTMLDivElement>(null);
  // Ref to the ReopenFab so we can move focus to it on panel close.
  const fabRef = useRef<HTMLButtonElement>(null);
  // Ref to the PanelHandle so we can move focus to it on panel open.
  const panelHandleRef = useRef<HTMLButtonElement>(null);
  // Live-drag preview offset (null when not dragging the handle).
  const dragStartYRef = useRef<number | null>(null);
  const [dragDy, setDragDy] = useState<number | null>(null);
  // True when the current zoom is at the fit-to-screen floor (drives ⊡ active).
  const [atFit, setAtFit] = useState(true);
  // Reactive limit flags — updated by onZoom so buttons disable at scale extremes.
  const [canZoomIn, setCanZoomIn] = useState(true);
  const [canZoomOut, setCanZoomOut] = useState(true);
  // Dock height in CSS px, published as --lp-dock-h for ZoomControls positioning.
  const dockHeightRef = useRef(0);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
    try { localStorage.setItem("lp:panel:open", open ? "true" : "false"); } catch { /* ignore */ }
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    requestAnimationFrame(() => fabRef.current?.focus());
  }, [setPanelOpen]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    requestAnimationFrame(() => panelHandleRef.current?.focus());
  }, [setPanelOpen]);

  // Dock height → renderer bottom inset (AC-R2-2/3) + CSS var for ZoomControls.
  // Runs on panel state change and whenever the dock content resizes.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const update = (): void => {
      const h = el.offsetHeight;
      dockHeightRef.current = h;
      const inset = panelOpenRef.current ? h : 0;
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
  }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const r = selectionRef.current.apply(x, y, c);
      if (r.kind === "cap") {
        // While cooling, the cap is the single armed "next" cell — frame the
        // refusal as anticipation, not a full gauge (you can re-aim, not stack).
        showToast(
          onCooldownRef.current
            ? { kind: "cooldown", messageKey: "canvas.cooldown.armed", params: { seconds: cooldownSecondsRef.current } }
            : { kind: "cap", messageKey: "canvas.feedback.capReached", params: { max: r.cap } },
        );
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
    for (const cell of cells) {
      const msg = placement.place(cell.x, cell.y, cell.color);
      if (msg) netRef.current?.place(msg);
    }
    syncOverlay();
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
  const openInspect = useCallback((x: number, y: number) => {
    setInspect({ x, y });
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
  }, []);

  // FEN-390: keep the renderer's marching-ants frame in sync with the
  // inspected cell. Clear when the panel closes (inspect=null) or when draw
  // mode starts (pixelInfo unmounts — the frame must disappear with it).
  useEffect(() => {
    rendererRef.current?.setInspectedCell(!drawing && inspect ? inspect : null);
  }, [inspect, drawing]);

  // "Dessiner": leave the info panel and enter selection mode, staging the
  // inspected cell as the first cell of the batch (FEN-249 — selection starts
  // here, exactly the prior draw behaviour). Account-gated (FEN-115): entering
  // draw mode is itself an account-requiring interaction.
  const drawFromInspect = useCallback(() => {
    if (!inspect) return;
    if (!requireAccount("enter-draw")) return;
    const { x, y } = inspect;
    setDrawing(true);
    closeInspect();
    stageCell(x, y);
  }, [inspect, requireAccount, closeInspect, stageCell]);

  // "Poser ici" (FEN-338 / maquette): the dock's persistent primary CTA when no
  // batch is staged yet. It opens placement (enters draw mode) so the always-on
  // CTA in the maquette has a behaviour — tapping it invites aiming a cell, which
  // then stages and flips the CTA to "Confirmer". Account-gated exactly like the
  // info-panel "Dessiner" entry (entering draw mode is account-requiring, FEN-115).
  const startPose = useCallback(() => {
    if (!requireAccount("enter-draw")) return;
    setDrawing(true);
  }, [requireAccount]);

  // Annuler: empty the batch, close any info panel, and leave draw mode.
  const cancel = useCallback(() => {
    selectionRef.current.clear();
    closeInspect();
    setDrawing(false);
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
      // Keep the renderer's top-inset in sync so drawBoardBorder clamps correctly
      // in both cover (mobile) and fit (desktop) modes (FEN-470).
      rendererRef.current?.setTopInset(bottom);
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

  // Tick once a second while the gauge is empty so the countdown re-renders and
  // the re-peek fires at expiry. Continues past cooldownUntil until a server
  // `gauge` frame with charges ≥ 1 lands (prevents the stale-zero bug: FEN-409).
  const peekSentForRef = useRef<number>(0); // cooldownUntil already peeked — avoids spam
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

  // Mount: build renderer + net client, connect. Teardown on unmount.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const renderer = new CanvasRenderer(
      el,
      {
        onTap: (x, y, pointerType) => {
          void pointerType;
          // In draw mode → stage the cell (the prior selection behaviour;
          // stageCell prevents staging when blocked and explains why).
          if (drawingRef.current) {
            stageCell(x, y);
            return;
          }
          // Refonte FEN-249: outside draw mode a click NEVER enters selection —
          // it opens the read-only pixel-info panel (coords + author), for every
          // pointer type and in every place-state.
          openInspect(x, y);
        },
        onHover: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
        },
        // ZoomControls ⊡ active indicator (AC-R2-3, FEN-370).
        // Also refreshes zoom-limit flags so +/− disable at extremes (FEN-414).
        onZoom: (fit: boolean) => {
          setAtFit(fit);
          setCanZoomIn(rendererRef.current?.canZoomIn ?? true);
          setCanZoomOut(rendererRef.current?.canZoomOut ?? true);
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
      },
      // Transparent backing so the neutral Arcade field (FrescoCanvas:
      // `--canvas-field`, FEN-269) shows in the letterbox around the board
      // instead of the legacy dark backdrop — chromatic neutrality so a posed
      // pixel reads true. The board pixels themselves are still painted opaque.
      {
        interactive: true,
        background: null,
        // Cover the viewport (no neutral dead field) on compact viewports (B1).
        cover: typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches,
      },
    );
    rendererRef.current = renderer;
    // Seed the topbar inset so the board border is correct from the first frame
    // (the topbar publish effect runs before this effect but rendererRef is not
    // set yet at that point — FEN-470).
    if (topbarRef.current) {
      renderer.setTopInset(topbarRef.current.offsetTop + topbarRef.current.offsetHeight);
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
    void net.connect();

    return () => {
      net.disconnect();
      renderer.destroy();
      rendererRef.current = null;
      netRef.current = null;
      placementRef.current = null;
    };
  }, [slug, showToast, stageCell, validate, cancel, openInspect]);

  // Re-authenticate the socket when Convex auth flips (FEN-184). The mount effect
  // above connects exactly once — anonymously on the post-OAuth landing, because
  // the JWT isn't resolvable yet. When Convex confirms auth (~1s later), reconnect
  // so `fetchTicket` re-runs and the socket carries the token: the gateway then
  // resolves `userId` and serves the per-user gauge that lifts the indicator out
  // of "loading". On sign-out it flips back to false → reconnect drops to the
  // anonymous read-only socket. Skip the very first run (the mount connect owns
  // the initial open) so we don't double-connect; only act on an actual change.
  const prevConvexAuthedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevConvexAuthedRef.current === null) {
      prevConvexAuthedRef.current = convexAuthed;
      return;
    }
    if (prevConvexAuthedRef.current === convexAuthed) return;
    prevConvexAuthedRef.current = convexAuthed;
    netRef.current?.reconnect();
  }, [convexAuthed]);

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

  // Cooldown view-state at component scope: read by the per-second tick re-render
  // and by the FEN-118 "gauge-empty" anticipation nudge below. Based on the real
  // server gauge (the optimistic tier overlay is folded in separately, below).
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

  // Arcade Gauge inputs (FEN-269): the same effective gauge the indicator reads,
  // so a just-claimed réserve grows the bar instantly. Empty reserve ⇒ a draining
  // cooldown ring; otherwise a segmented k/N reserve. The ring drain is decorative
  // (AC8): GaugeState carries no regen interval, so latch the cooling cycle length
  // the first tick it grows and reset when charges return — the tnum seconds count
  // (kept by deriveCooldownView) is the real carrier of the remaining time.
  const ringTotalRef = useRef(0);
  const effOnCooldown = effectiveGauge !== null && effectiveGauge.charges <= 0;
  const ringSeconds = cooldownView?.secondsUntilNext ?? 0;
  if (!effOnCooldown) ringTotalRef.current = 0;
  else if (ringSeconds > ringTotalRef.current) ringTotalRef.current = ringSeconds;
  const ringPercent = cooldownRingPercent(ringSeconds, ringTotalRef.current);

  // Viewer legibility of moderation events (Lot I, FEN-121): explain a collective
  // event without jargon or anxiety. Two signals feed the reducer: the
  // frozen/reopen transition (via canPlace → placement_closed → the `frozen`
  // state) and the wipe `areaChanged` signal — the monotonic `bulkChangeSeq` the
  // net layer bumps on each server-initiated `moderationEvent` frame (FEN-163,
  // distinct from a reconnect resync). Kept out of the unified place-state
  // indicator: this is a transient "something happened" banner, not the standing
  // "can I place?" answer, and it announces politely (never an alert).
  const prevLivenessRef = useRef<CanvasLiveness>({ frozen: false, bulkChangeSeq: 0 });
  const [modNotice, setModNotice] = useState<MessageKey | null>(null);
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

  const sel = selectionRef.current;
  const count = sel.count; // re-read each render; selVersion forces the refresh
  void selVersion;

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

  return (
    <div className="lp-app">
      {/* Neutral framed field around the live board (FrescoCanvas, FEN-269):
          chromatic neutrality so a posed pixel reads true (selector == pixel).
          The canvas keyboard a11y (text alternative + polite cursor readout,
          FEN-123/U3) rides inside the frame as the canvas's described-by. */}
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
          {viewers !== null && (
            <span className="lp-pill">
              <span className="lp-pill-dot" aria-hidden="true">
                ●
              </span>
              {t("canvas.viewers", { count: viewers })}
            </span>
          )}
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
              {/* canvas → gallery: a light escape hatch so the hero isn't an island (FEN-114). */}
              <Link to={paths.gallery()} className="lp-navlink">
                {t("nav.gallery")}
              </Link>
              {/* "Partager" — copy the public /c/:slug link. Rendered unconditionally
                  (no auth gate) so anonymous viewers can share too (FEN-304 AC2). */}
              <ShareButton slug={slug} />
              <LanguageSwitcher />
              {/* Identity / "Se déconnecter" lives INSIDE the overflow menu now
                  (FEN-338 / handoff §3.3 / AC-3): the maquette's topbar is wordmark
                  + counter + ≡ only, so the red sign-out no longer dominates. On
                  desktop the secondary group is `display:contents`, so the auth
                  control still renders inline as the last bar item exactly as
                  before — desktop is unchanged (AC-9). The signed-out connect CTA
                  is still the primary affordance via the dock's large Twitch button
                  (AC-3), so collapsing it here strands no one. */}
              <AuthButton />
            </div>
          </div>
        </div>
      </div>

      {/* The single compact action dock (FEN-311, mobile refonte). `data-pose`
          drives the mobile layout: at rest it is a short bottom dock (canvas
          ≥75 % height, centre never covered — AC-1/AC-2); in pose mode the
          palette surface unfolds inside it as a bounded bottom-sheet (AC-4/AC-5).
          On desktop the dock keeps its bottom-left panel layout (no regression —
          AC-16). `data-auth` lets the non-connected screen drop the palette and
          surface the Twitch CTA alone (AC-3).
          R2 (FEN-370): `data-panel-open` drives the CSS slide transition;
          inline translateY previews the live drag so the panel follows the finger. */}
      <div
        className="lp-hud"
        ref={dockRef}
        data-pose={drawing || count > 0 ? "on" : "off"}
        data-staged={count > 0 ? "yes" : "no"}
        data-auth={convexAuthed ? "in" : "out"}
        data-panel-open={panelOpen ? "true" : "false"}
        aria-label={t("canvas.panel.label")}
        style={dragDy !== null ? { transform: `translateY(${dragDy}px)` } : undefined}
      >
        {/* PanelHandle (R2 FEN-370 AC-R2-1/4): real interactive affordance that
            replaces the decorative ::before. Drag-to-close + keyboard toggle.
            Role="separator" marks it as a resize control (ARIA spec). */}
        <button
          ref={panelHandleRef}
          type="button"
          role="separator"
          aria-label={panelOpen ? t("canvas.panel.close") : t("canvas.panel.open")}
          aria-expanded={panelOpen}
          className="lp-panel-handle"
          onClick={panelOpen ? closePanel : openPanel}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              panelOpen ? closePanel() : openPanel();
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragStartYRef.current = e.clientY;
          }}
          onPointerMove={(e) => {
            if (dragStartYRef.current === null) return;
            const dy = e.clientY - dragStartYRef.current;
            setDragDy(Math.max(0, dy));
          }}
          onPointerUp={(e) => {
            if (dragStartYRef.current === null) return;
            const dy = e.clientY - dragStartYRef.current;
            dragStartYRef.current = null;
            setDragDy(null);
            if (dy > (dockHeightRef.current || 200) * 0.25) closePanel();
          }}
          onPointerCancel={() => {
            dragStartYRef.current = null;
            setDragDy(null);
          }}
        >
          <span aria-hidden="true" className="lp-panel-handle-grip" />
        </button>
        <h1>{t("app.title")}</h1>

        {/* Rang 1 — unified "puis-je poser ?" indicator (Lot E, FEN-117). One
            line answering yes/no + why + when, with a text label for every
            state (C6), superseding the raw gauge/cooldown readout (the charge
            count and the cooldown countdown are carried in its messages). The
            `data-state` exposes the machine state for the UI phase to style; no
            colour decision is made here. It is also the always-mounted focus
            anchor after an encash (FEN-140 #1): when the claim signal empties,
            focus moves here — the live réserve status (it shows the grown count
            via the effective gauge) — instead of falling to <body>. */}
        <p
          ref={gaugeRef}
          tabIndex={-1}
          className={`lp-state${placeState.canPlace ? " is-ready" : " is-blocked"}`}
          data-state={placeState.kind}
          role="status"
          aria-live="polite"
        >
          {/* The Arcade StatusPill renders the icon+label (never colour alone,
              AA); the 11 place-states project onto its 5 variants via the pure,
              unit-tested pillStateForPlace. The label stays the precise i18n
              carrier; the <p> remains the live region + focus anchor (FEN-140). */}
          <StatusPill
            state={pillStateForPlace(placeState.kind)}
            label={t(placeState.messageKey as MessageKey, placeState.params)}
          />
        </p>

        {/* Réserve + compte à rebours (FEN-418 B1/B2): horizontal bar gauge
            replaces the segmented reserve. Two bars: total (gray) + available
            (accent fill). A third animated projection bar appears while a batch
            is staged showing pixels remaining after the pose (B2/B3). While the
            reserve refills, the draining cooldown ring sits above it. All
            decorative-only aria (the StatusPill carries the announced semantics). */}
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

        {/* Lot F (FEN-119) — active cooldown: a forward-oriented line that turns
            the wait into anticipation. It invites aiming the next cell, confirms
            it is armed, then prompts the single confirm gesture at refill. Sober
            (no "skip cooldown"); a status, not an alert. `data-phase` exposes the
            engagement phase for the UI phase to style (visual delegated).

            a11y (FEN-165): the phase text is the only live content, so the polite
            live region announces phase transitions (waiting → armed → refilled)
            ONCE, not the ticking seconds every tick. The visible per-second
            countdown stays for sighted users but lives in an aria-hidden span so
            screen readers skip it. This line owns the single forward-framed
            countdown; rang-1 (lp-state) no longer reprints the seconds. */}
        {cooldownView?.messageKey && (
          <p className="lp-cooldown" data-phase={cooldownView.phase} role="status">
            {t(cooldownView.messageKey as MessageKey, cooldownView.params)}
            {cooldownView.onCooldown && cooldownView.secondsUntilNext > 0 && (
              <span className="lp-cooldown-secs" aria-hidden="true">
                {" — "}
                {t("canvas.cooldown.seconds", { seconds: cooldownView.secondsUntilNext })}
              </span>
            )}
          </p>
        )}

        {/* Moderation-event legibility (Lot I, FEN-121): a brief, non-anxiogène
            "a collective event just happened" note. Polite (informational, not an
            alert), auto-dismissing, and carries a text label (C6 — colour/icon
            delegated to the UI phase). */}
        {modNotice && (
          <p className="lp-mod-notice" role="status" aria-live="polite" data-mod-notice>
            {t(modNotice)}
          </p>
        )}

        {/* Lot D — claim signal (FEN-116): non-blocking, persistent, stackable.
            The viewer encashes a tier earned by playing; nothing else (no
            points/shop). */}
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
            <Button variant="primary" className="lp-claim-btn" onClick={claimNext}>
              {pendingTiers > 1 ? t("canvas.claim.actionOne") : t("canvas.claim.action")}
            </Button>
            {pendingTiers > 1 && (
              <Button variant="secondary" className="lp-claim-all" onClick={claimAll}>
                {t("canvas.claim.all", { count: pendingTiers })}
              </Button>
            )}
          </div>
        )}

        {/* Non-connected (AC-3): the dock's standing primary action is the
            Twitch CTA — the palette/pose surface below is not rendered at all,
            so the only thing a signed-out viewer sees over the canvas is this
            compact connect button and the read-only state line. */}
        {!convexAuthed && (
          <Button
            className="lp-cta lp-auth__twitch"
            icon={<TwitchGlyph size={20} />}
            onClick={() => void signInWithTwitch()}
          >
            {t("auth.signIn")}
          </Button>
        )}

        {/* Pixel-info panel (FEN-249): a click opens this read-only panel with
            the cell's coordinates + who placed it; selection mode starts only
            via "Dessiner", and the pose only runs after "Confirmer". An empty
            cell shows "aucun auteur" (not an error); the author line is
            "indisponible" until the viewer-facing backend attribution query
            lands (dependency flagged on FEN-249). Read-only, so it stays
            available to anonymous viewers — but "Dessiner" (which enters pose
            mode) is swapped for the connect CTA when signed out (AC-3). */}
        {pixelInfo && (
          <div
            className="lp-pixelinfo"
            role="dialog"
            aria-label={t("canvas.pixelInfo.title")}
            data-author-state={pixelInfo.authorState}
          >
            <p className="lp-pixelinfo-coords">
              {t("canvas.pixelInfo.coords", { x: pixelInfo.x, y: pixelInfo.y })}
            </p>
            <p className="lp-pixelinfo-author">
              {/* « Posé anonymement » is a self-contained phrase, so the "Posé par"
                  prefix would read as the broken "Posé par Posé anonymement" — drop
                  the label in the anonymous case (FEN-332). */}
              {pixelInfo.authorState !== "unknown" && (
                <>
                  <span className="lp-pixelinfo-author-label">{t("canvas.pixelInfo.authorLabel")}</span>{" "}
                </>
              )}
              <span className="lp-pixelinfo-author-value">{pixelInfoAuthorText}</span>
            </p>
            <div className="lp-pixelinfo-actions">
              {convexAuthed ? (
                <Button variant="primary" className="lp-pixelinfo-draw" onClick={drawFromInspect}>
                  {t("canvas.draw")}
                </Button>
              ) : (
                <Button
                  className="lp-pixelinfo-draw lp-auth__twitch"
                  icon={<TwitchGlyph size={20} />}
                  onClick={() => void signInWithTwitch()}
                >
                  {t("auth.signIn")}
                </Button>
              )}
              <Button variant="ghost" className="lp-pixelinfo-close" onClick={closeInspect}>
                {t("canvas.pixelInfo.close")}
              </Button>
            </div>
          </div>
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
            {/* Palette (heading + swatches + eraser) only in draw mode (FEN-401 R2,
                FEN-418 A5): eraser lives at index 0 of the palette so it is only
                visible in draw mode, never outside selection mode (A5). */}
            {drawing && (
              <>
                <span className="lp-pose-heading">{t("canvas.palette.heading")}</span>
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
                  eraser={eraserItem}
                  ariaLabel={t("canvas.palette")}
                />
              </>
            )}

            {/* Persistent thumb-zone primary CTA (FEN-338 / maquette): the dock
                ALWAYS shows the big full-width "Poser" button so it matches the
                maquette's signature CTA (the QA side-by-side FAIL trigger). Its
                label + action follow the place-state: a staged batch confirms;
                an idle ready dock invites placing (enters draw mode, "Poser
                ici"); a depleted reserve disables with "Attends la recharge"
                (design §"CTA désactivé explique pourquoi"). `size=lg` +
                `lp-cta-poser` span the dock width where the thumb reaches. */}
            <Button
              variant="primary"
              size="lg"
              className="lp-cta-poser"
              disabled={count > 0 ? sel.isLocked || !placeState.canPlace : !placeState.canPlace}
              onClick={count > 0 ? validate : inspect ? drawFromInspect : startPose}
            >
              {count > 0
                ? t("canvas.validate", { count })
                : placeState.canPlace
                  ? t("canvas.placeHere")
                  : t("canvas.poseWait")}
            </Button>

            {/* Secondary tools row. On mobile it is hidden at rest (CSS, keyed on
                `.lp-hud[data-pose="off"]`) so the resting dock matches the maquette
                (gauge + palette + one CTA); it reappears once placement is underway.
                Gommer is now the eraser item in the palette at index 0 (FEN-418 A5/A7)
                so there is no standalone Gommer button here. */}
            <div className="lp-tools">
              {/* Always-visible exit while building or in draw mode (U4):
                  "Annuler" with a pending batch, "Terminer" when empty so there
                  is always a way out of draw mode — this is also the gesture
                  that folds the mobile palette sheet back to a full canvas. */}
              {(count > 0 || drawing) && (
                <Button variant="ghost" onClick={cancel}>
                  {count > 0 ? t("canvas.cancel") : t("canvas.finish")}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Contextual guidance only: the batch hint ("select a cell, then
            Confirm") is shown WHILE building (draw mode), so it is transient, not
            a permanent strip. The idle entry hint ("click a pixel to inspect;
            Draw to start placing") was REMOVED from the dock (FEN-329 / anchor §3)
            — it bloated the resting dock and pushed the canvas below the AC-1 75%
            target. That guidance now lives in the always-available "?" recall
            (canvas.onboarding.recall), reachable from the topbar overflow menu. */}
        {count === 0 && !pixelInfo && drawing && <p className="lp-hint">{t("canvas.batchHint")}</p>}
      </div>

      {/* ReopenFab (R2 FEN-370 AC-R2-1): persistent thumb-zone signifier that
          keeps "panel closed" from being a dead-end (Nielsen #3 user control).
          Visible only on mobile when the panel is closed (CSS: .lp-fab on mobile).
          Badge shows staged batch count or "!" when a tier is pending (Zeigarnik). */}
      <button
        ref={fabRef}
        type="button"
        className="lp-fab"
        aria-label={
          pendingTiers > 0
            ? t("canvas.panel.fabTier")
            : count > 0
              ? t("canvas.panel.fabStaged", { count })
              : t("canvas.panel.open")
        }
        onClick={openPanel}
        hidden={panelOpen}
      >
        {/* 2×2 pixel-cluster glyph — on-brand signifier: the placing tools live here.
            Inline SVG so it never depends on an emoji font (AC-3 / FEN-326). */}
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" opacity=".85" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" opacity=".85" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
        </svg>
        {(pendingTiers > 0 || count > 0) && (
          <span
            aria-hidden="true"
            className={`lp-fab-badge${pendingTiers > 0 ? " lp-fab-badge--tier" : ""}`}
          >
            {pendingTiers > 0 ? "!" : count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {/* ZoomControls (R2 FEN-370 / FEN-388): explicit +/−/⊡ so pinch-to-zoom is
          not the ONLY path (pinch with touch-action:none is not discoverable,
          Paradox of the Active User). Fixed at bottom-right on all viewports
          (FEN-388 extended from mobile-only to desktop too). The ⊡ button fits
          the whole fresco; it shows active (aria-pressed) at the fit floor.
          Mobile: bottom floats above dock via --lp-dock-h CSS var (set above). */}
      <div className="lp-zoom-controls" role="group" aria-label={t("canvas.zoom.label")}>
        <button
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
          type="button"
          className="lp-zoom-btn"
          aria-label={t("canvas.zoom.fit")}
          aria-pressed={atFit}
          onClick={() => rendererRef.current?.fitToScreen()}
        >
          ⊡
        </button>
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
              toast.kind === "cooldown" || toast.kind === "cap"
                ? "info"
                : "error"
            }
            title={t(toast.messageKey as MessageKey, toast.params)}
            onClose={() => setToast(null)}
            closeLabel={t("canvas.toast.close")}
          />
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
