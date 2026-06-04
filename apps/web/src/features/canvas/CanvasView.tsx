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
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { OptimisticPlacement, type PlacementFeedback } from "./placement.js";
import { BatchSelection, EMPTY_COLOR } from "./selection.js";
import { gateInteraction, type CanvasInteraction } from "./authGate.js";
import { gatewayWsUrl } from "./gateway.js";
import "./canvas.css";

const DEFAULT_COLOR = 5; // red — a visible default pose colour
const TOAST_MS = 2600;

interface ToastState {
  kind: PlacementFeedback["kind"] | "cap";
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface CanvasViewProps {
  /** Canvas slug; null targets the default canvas (`/ws`). */
  slug?: string | null;
}

export function CanvasView({ slug = null }: CanvasViewProps): React.ReactElement {
  const t = useTranslate();
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
  const [selVersion, setSelVersion] = useState(0); // bumped on every batch change
  const [, setTick] = useState(0); // drives the per-second cooldown countdown

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
      if (r.kind === "cap") {
        showToast({ kind: "cap", messageKey: "canvas.feedback.capReached", params: { max: r.cap } });
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
    const cells = selectionRef.current.take();
    for (const cell of cells) {
      const msg = placement.place(cell.x, cell.y, cell.color);
      if (msg) netRef.current?.place(msg);
    }
    setArmed(null);
    syncOverlay();
  }, [requireAccount, syncOverlay]);

  // Annuler: empty the batch and leave draw mode.
  const cancel = useCallback(() => {
    selectionRef.current.clear();
    setArmed(null);
    setDrawing(false);
    syncOverlay();
  }, [syncOverlay]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  // Tick once a second while on cooldown so the countdown re-renders.
  useEffect(() => {
    const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
    if (!onCooldown) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [gauge]);

  // The gauge ceiling drives the batch cap (k/N).
  useEffect(() => {
    selectionRef.current.setCapacity(gauge?.charges ?? 0);
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
          setArmed({ x, y });
        },
        onHover: (cell) => {
          hoverRef.current = cell;
          rendererRef.current?.setOverlay(selectionRef.current.entries(), cell);
        },
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
  }, [slug, showToast, stageCell]);

  const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
  const cooldownSeconds = onCooldown ? Math.max(0, Math.ceil((gauge!.cooldownUntil - Date.now()) / 1000)) : 0;

  const sel = selectionRef.current;
  const count = sel.count; // re-read each render; selVersion forces the refresh
  void selVersion;

  return (
    <div className="lp-app">
      <canvas ref={canvasRef} className="lp-canvas" />

      <div className="lp-topbar">
        {viewers !== null && <span className="lp-pill">{t("canvas.viewers", { count: viewers })}</span>}
        {status !== "open" && (
          <span className="lp-pill">{t(status === "connecting" ? "canvas.connecting" : "canvas.offline")}</span>
        )}
        <AuthButton />
        <LanguageSwitcher />
      </div>

      <div className="lp-hud">
        <h1>{t("app.title")}</h1>

        <p className={`lp-gauge${onCooldown ? " is-empty" : ""}`}>
          {gauge === null
            ? t("canvas.connecting")
            : onCooldown
              ? t("canvas.cooldown", { seconds: cooldownSeconds })
              : count > 0
                ? t("canvas.batchCount", { count, max: sel.capacity })
                : t("canvas.gauge", { current: gauge.charges, max: gauge.max })}
        </p>

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

          {/* Mobile gate: confirm intent to draw on the armed cell. */}
          {armed && !drawing && (
            <button
              type="button"
              className="lp-btn is-primary"
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
          )}

          {/* Valider / Annuler appear once the batch is non-empty. */}
          {count > 0 && (
            <>
              <button type="button" className="lp-btn is-primary" disabled={sel.isLocked} onClick={validate}>
                {t("canvas.validate", { count })}
              </button>
              <button type="button" className="lp-btn" onClick={cancel}>
                {t("canvas.cancel")}
              </button>
            </>
          )}
        </div>

        {count === 0 && !armed && <p className="lp-hint">{t("canvas.batchHint")}</p>}
      </div>

      {toast && (
        <div className={`lp-toast${toast.kind === "cooldown" ? " is-cooldown" : ""}`} role="status">
          {t(toast.messageKey as MessageKey, toast.params)}
        </div>
      )}
    </div>
  );
}
