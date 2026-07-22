/**
 * CanvasChrome — topbar, zoom controls, toasts, modals, and navigation sheets
 * extracted from CanvasView.tsx (l.1797-1898, l.2237-2395, FEN-1948).
 *
 * Renders as a React.Fragment wrapping:
 *   1. `div.lp-topbar` — before `{children}`
 *   2. `{children}` — the HUD BottomSheet injected by CanvasView
 *   3. ZoomControls · Toast · AuthModal · StudioPanel · ShortcutsSheet · NavSheet
 *
 * This ordering preserves the original DOM sequence (topbar → HUD → chrome).
 */
import { useRef } from "react";
import type { TranslateFn } from "@canvas/i18n";
import { LanguageSwitcher } from "@canvas/i18n/react";
import { Link } from "@tanstack/react-router";
import { AuthButton } from "../../auth/AuthButton.js";
import { ShareButton } from "./ShareButton.js";
import { StudioPanel } from "../streamer/StudioPanel.js";
import { StudioDashboardBody } from "../streamer/StudioDashboardBody.js";
import type { CanvasRenderer } from "./renderer.js";
import {
  BottomSheet,
  Button,
  Toast,
  Wordmark,
} from "../../ui/index.js";
import { AuthModal } from "../../auth/AuthModal.js";
import { SoundToggle } from "./SoundToggle.js";

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Chip + rôle pour un raccourci clavier (FEN-1872). Exported for HUD headerLeft. */
export function ShortcutItem({ keyLabel, role }: { keyLabel: string; role: string }) {
  return (
    <span className="lp-sc-item">
      <kbd className="lp-sc-key">{keyLabel}</kbd>
      <span className="lp-sc-role">{role}</span>
    </span>
  );
}

/** Bottom sheet listing all keyboard shortcuts (FEN-1884). */
function ShortcutsSheet({
  open,
  onClose,
  drawing,
  t,
  triggerEl,
}: {
  open: boolean;
  onClose: () => void;
  drawing: boolean;
  t: TranslateFn;
  triggerEl: HTMLElement | null;
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      presentation="modal"
      showHandle
      dragDismiss
      titleId="lp-sc-sheet-title"
      triggerEl={triggerEl}
    >
      <h2 id="lp-sc-sheet-title" className="lp-sc-sheet-title">
        {t("canvas.shortcuts.title")}
      </h2>
      <div className="lp-sc-sheet-list">
        <ShortcutItem keyLabel={t("canvas.shortcuts.key.esc")} role={t("canvas.shortcuts.role.esc")} />
        <ShortcutItem
          keyLabel={t("canvas.shortcuts.key.enter")}
          role={drawing ? t("canvas.shortcuts.role.enter.validate") : t("canvas.shortcuts.role.enter.draw")}
        />
        <ShortcutItem keyLabel="E" role={t("canvas.shortcuts.role.e")} />
        <ShortcutItem keyLabel="I" role={t("canvas.shortcuts.role.i")} />
        <ShortcutItem keyLabel="G" role={t("canvas.shortcuts.role.g")} />
        <ShortcutItem keyLabel={t("canvas.shortcuts.key.space")} role={t("canvas.shortcuts.role.space")} />
      </div>
    </BottomSheet>
  );
}

// ─── Shared timing constant ───────────────────────────────────────────────────

export const TOAST_MS = 2600;

// ─── Toast shape ─────────────────────────────────────────────────────────────

export interface ToastState {
  kind: string;
  messageKey: string;
  params?: Record<string, string | number>;
}

// ─── Modal data ──────────────────────────────────────────────────────────────

export interface ModalData {
  callbackURL: string;
  streamer: string | null;
  hasDrawIntent: boolean;
}

// ─── CanvasChrome props ───────────────────────────────────────────────────────

export interface CanvasChromeProps {
  children: React.ReactNode; // HUD BottomSheet from CanvasView

  // Topbar refs (DOM attachment; created in CanvasView for ResizeObserver / focus)
  topbarRef: React.RefObject<HTMLDivElement>;

  // Zoom control refs (created in CanvasView for onZoom focus redirect)
  zoomInRef: React.RefObject<HTMLButtonElement>;
  zoomOutRef: React.RefObject<HTMLButtonElement>;
  fitRef: React.RefObject<HTMLButtonElement>;

  // Modal ref (created in CanvasView; captured in requireAccount focus handler)
  modalTriggerRef: React.RefObject<HTMLElement>;

  // Canvas metadata
  slug: string | null;
  /** `canvasDoc?.status` — drives the "● Ouvert" badge in the desktop topbar. */
  canvasDocStatus?: string | null;

  // Owner flag
  isCanvasOwner: boolean;

  // Studio sheet
  studioOpen: boolean;
  onStudioOpen: () => void;
  onStudioClose: () => void;

  // Keyboard shortcuts sheet
  shortcutsOpen: boolean;
  onShortcutsOpen: () => void;
  onShortcutsClose: () => void;
  drawing: boolean;

  // Burger nav sheet
  menuOpen: boolean;
  onMenuOpen: () => void;
  onMenuClose: () => void;

  // Sound
  soundEnabled: boolean;
  onSoundToggle: () => void;
  autoplayBlocked: boolean;

  // Auth
  onSignIn: () => void;
  convexAuthed?: boolean;

  // Zoom state (drives button disabled/aria-pressed)
  canZoomIn: boolean;
  canZoomOut: boolean;
  atFit: boolean;
  rendererRef: React.MutableRefObject<CanvasRenderer | null>;

  // Toast
  toast: ToastState | null;
  onToastClose: () => void;

  // Auth modal
  modalData: ModalData | null;
  onModalDismiss: () => void;
  onModalBeforeRedirect: () => void;

  t: TranslateFn;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CanvasChrome({
  children,
  topbarRef,
  zoomInRef,
  zoomOutRef,
  fitRef,
  modalTriggerRef,
  slug,
  canvasDocStatus,
  isCanvasOwner,
  studioOpen,
  onStudioOpen,
  onStudioClose,
  shortcutsOpen,
  onShortcutsOpen,
  onShortcutsClose,
  drawing,
  menuOpen,
  onMenuOpen,
  onMenuClose,
  soundEnabled,
  onSoundToggle,
  autoplayBlocked,
  onSignIn,
  canZoomIn,
  canZoomOut,
  atFit,
  rendererRef,
  toast,
  onToastClose,
  modalData,
  onModalDismiss,
  onModalBeforeRedirect,
  t,
}: CanvasChromeProps): React.ReactElement {
  // menuTriggerRef and shortcutsTriggerRef are purely intra-chrome (only used as
  // triggerEl for focus-return on BottomSheet close) — created here, not shared.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const shortcutsTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* ── Topbar (l.1797-1898) ───────────────────────────────────────────── */}
      <div className="lp-topbar" ref={topbarRef}>
        {/* Brand wordmark (FEN-338 / handoff §3.2) — corrects défaut "aucune
            marque". Shown only on the mobile fine bar (left); on desktop the
            global chrome owns the brand, so this is `display:none` there and the
            floating top-right bar is left untouched (AC-9). */}
        <Link to="/" className="lp-topbar-home-link">
          <Wordmark size="sm" className="lp-topbar-brand" />
        </Link>
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
          <div className="lp-topbar-menu">
            {/* FEN-1660: burger trigger — opens the nav bottom sheet on mobile.
                display:none on desktop (CSS), so the BottomSheet is never opened
                there (desktop uses lp-tb-center/lp-tb-right inline layout). */}
            <button
              type="button"
              ref={menuTriggerRef}
              className="lp-navlink lp-topbar-menu-trigger"
              aria-haspopup="dialog"
              aria-label={t("canvas.menu.open")}
              onClick={onMenuOpen}
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
          </div>
        </div>

      {/* ---- Desktop R2 topbar zones (FEN-1052) — display:none on mobile ----
          Three zones: left (brand+title+status) · centre (nav) · right
          (utilities+account). The existing mobile structure above stays
          pixel-identical at <1024px; CSS switches which is shown at ≥1024px. */}

      {/* Zone gauche : wordmark + titre fresque + pastille statut */}
      <div className="lp-tb-left">
        <Link to="/" className="lp-topbar-home-link">
          <Wordmark size="sm" />
        </Link>
        {slug && (
          <>
            <span className="lp-tb-div" aria-hidden="true" />
            <span className="lp-tb-title">{slug}</span>
          </>
        )}
        {canvasDocStatus === "open" && (
          <span className="lp-tb-open">
            <span aria-hidden="true">● </span>
            {t("canvas.status.open")}
          </span>
        )}
      </div>

      {/* Zone centre : nav primaire (vide — Studio déplacé en tête de la zone droite) */}
      <nav className="lp-tb-center" aria-label={t("nav.primary")} />

      {/* Zone droite : utilitaires + compte */}
      <div className="lp-tb-right">
        {isCanvasOwner && (
          <Button
            size="sm"
            className="lp-tb-studio"
            aria-haspopup="dialog"
            aria-expanded={studioOpen}
            onClick={onStudioOpen}
          >
            {t("canvas.menu.studio")}
          </Button>
        )}
        <SoundToggle
          on={soundEnabled}
          onChange={onSoundToggle}
          blocked={autoplayBlocked}
        />
        <button
          ref={shortcutsTriggerRef}
          type="button"
          className="lp-sc-trigger"
          aria-label={t("canvas.shortcuts.triggerLabel")}
          aria-haspopup="dialog"
          aria-expanded={shortcutsOpen}
          onClick={onShortcutsOpen}
        >
          ?
        </button>
        <ShareButton slug={slug} />
        <LanguageSwitcher />
        <AuthButton onSignIn={onSignIn} />
      </div>
      </div>

      {/* ── HUD injected by CanvasView ─────────────────────────────────────── */}
      {children}

      {/* ── ZoomControls (l.2237-2278) ────────────────────────────────────── */}
      {/* ZoomControls (R2 FEN-370 / FEN-388): explicit +/−/⊡ so pinch-to-zoom is
          not the ONLY path (pinch with touch-action:none is not discoverable,
          Paradox of the Active User). Fixed at bottom-right on all viewports
          (FEN-388 extended from mobile-only to desktop too). The ⊡ button fits
          the whole fresco; it shows active (aria-pressed) at the fit floor.
          Mobile: bottom floats above dock via --lp-dock-h CSS var (set above). */}
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
          ⊡
        </button>
      </div>

      {/* ── Toast (l.2280-2302) ───────────────────────────────────────────── */}
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
            title={t(toast.messageKey as Parameters<TranslateFn>[0], toast.params)}
            onClose={onToastClose}
            closeLabel={t("canvas.toast.close")}
          />
        </div>
      )}

      {/* ── AuthModal (l.2305-2315) ───────────────────────────────────────── */}
      {/* Pre-OAuth value modal (FEN-580 / G1): single intermediate screen before
          the Twitch redirect. Rendered outside the HUD so it is never clipped
          by the dock's overflow:hidden and can trap focus independently. */}
      <AuthModal
        open={modalData !== null}
        callbackURL={modalData?.callbackURL ?? "/"}
        streamer={modalData?.streamer ?? null}
        triggerEl={modalTriggerRef.current}
        onDismiss={onModalDismiss}
        onBeforeRedirect={onModalBeforeRedirect}
      />

      {/* ── StudioPanel (l.2318-2328) ─────────────────────────────────────── */}
      {/* S2 (FEN-1174): StudioPanel — mounted only for the canvas owner (AC3.6).
          `studioOpen` is orthogonal to panelOpen + menuOpen (R6). */}
      {isCanvasOwner && (
        <StudioPanel
          open={studioOpen}
          onClose={onStudioClose}
          titleId="lp-studio-title"
        >
          <StudioDashboardBody headingId="lp-studio-title" onClose={onStudioClose} />
        </StudioPanel>
      )}

      {/* ── ShortcutsSheet (l.2330-2337) ─────────────────────────────────── */}
      {/* FEN-1884: Keyboard shortcuts sheet — modal with handle/drag/Escape. */}
      <ShortcutsSheet
        open={shortcutsOpen}
        onClose={onShortcutsClose}
        drawing={drawing}
        t={t}
        triggerEl={shortcutsTriggerRef.current}
      />

      {/* ── Nav BottomSheet / burger (l.2339-2395) ───────────────────────── */}
      {/* FEN-1660: Navigation bottom sheet — replaces the floating dropdown for
          the burger menu on mobile. Reuses the existing BottomSheet component
          (same as pixel/mod section). Modal = backdrop + Escape + focus-trap. */}
      <BottomSheet
        open={menuOpen}
        onClose={onMenuClose}
        presentation="modal"
        showHandle
        dragDismiss
        className="lp-nav-sheet"
        ariaLabel={t("canvas.menu.open")}
        triggerEl={menuTriggerRef.current}
      >
        {/* Inner wrapper closes the sheet on any item activation, parity with
            the old lp-topbar-secondary onClick behaviour. */}
        <div onClick={onMenuClose}>
          {/* §0 — Studio (owner-only): visible seulement si isCanvasOwner. */}
          {isCanvasOwner && (
            <>
              <div className="lp-menu-section">
                <Button
                  size="md"
                  className="lp-tb-studio"
                  aria-haspopup="dialog"
                  onClick={() => {
                    onMenuClose();
                    onStudioOpen();
                  }}
                >
                  {t("canvas.menu.studio")}
                </Button>
              </div>
              <hr className="lp-menu-divider" />
            </>
          )}
          {/* §1 — Actions: share, sound. */}
          <div className="lp-menu-section">
            <ShareButton slug={slug} />
            <SoundToggle
              on={soundEnabled}
              onChange={onSoundToggle}
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
          {/* §4 — Compte. */}
          <div className="lp-menu-section">
            <AuthButton onSignIn={onSignIn} />
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
