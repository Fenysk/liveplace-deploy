/**
 * Live canvas client (FEN-65) — the interactive F3 surface wired to the F4
 * optimism/rollback controller over the FROZEN `@canvas/protocol`.
 *
 * Data flow:
 *   gateway socket ──► CanvasNetClient ──► binary snapshot/delta ──► CanvasRenderer
 *                                     └──► ack/error/cooldown/gauge ──► OptimisticPlacement
 *   user click ──► CanvasRenderer.onPlace ──► OptimisticPlacement.place() (paints
 *                  optimistically + returns the wire msg) ──► CanvasNetClient.place()
 *
 * The renderer doubles as the F4 {@link PlacementSurface}, so an optimistic pose
 * paints immediately and is committed (`ack`) or rolled back (`error`/`cooldown`)
 * on the gateway's verdict. The gauge/cooldown HUD (D1) and refusal toasts are
 * driven by the controller's `onGauge` / `onFeedback` callbacks, every string via
 * `@canvas/i18n` so the UI is FR/EN in place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";
import type { GaugeState } from "@canvas/protocol";
import { AuthButton } from "../../auth/AuthButton.js";
import { LanguageSwitcher } from "@canvas/i18n/react";
import { CanvasRenderer, PALETTE_HEX } from "./renderer.js";
import { CanvasNetClient, type ConnectionStatus } from "./net.js";
import { EMPTY_COLOR, OptimisticPlacement, type PlacementFeedback } from "./placement.js";
import { gatewayWsUrl } from "./gateway.js";
import "./canvas.css";

const DEFAULT_COLOR = 5; // red — a visible default pose colour
const TOAST_MS = 2600;

interface ToastState {
  kind: PlacementFeedback["kind"];
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

  // selection mirrored into refs so the renderer's place callback reads the
  // latest value without being re-bound on every change.
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [erasing, setErasing] = useState(false);
  const colorRef = useRef(color);
  const erasingRef = useRef(erasing);
  colorRef.current = color;
  erasingRef.current = erasing;

  const [gauge, setGauge] = useState<GaugeState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [viewers, setViewers] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [, setTick] = useState(0); // drives the per-second cooldown countdown

  const showToast = useCallback((f: PlacementFeedback) => {
    setToast({ kind: f.kind, messageKey: f.messageKey, params: f.params });
  }, []);

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

  // Mount: build renderer + net client, connect. Teardown on unmount.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const renderer = new CanvasRenderer(
      el,
      {
        onPlace: (x, y) => {
          const placement = placementRef.current;
          if (!placement) return;
          const c = erasingRef.current ? EMPTY_COLOR : colorRef.current;
          const msg = placement.place(x, y, c);
          if (msg) netRef.current?.place(msg);
        },
      },
      { interactive: true },
    );
    rendererRef.current = renderer;

    const net = new CanvasNetClient({
      url: gatewayWsUrl(slug),
      handlers: {
        onWelcome: (w) => {
          // Create the controller once, with the authoritative geometry.
          if (!placementRef.current) {
            placementRef.current = new OptimisticPlacement({
              width: w.width,
              height: w.height,
              paletteSize: renderer.paletteSize,
              surface: renderer,
              onGauge: setGauge,
              onFeedback: showToast,
            });
          }
        },
        onBinary: (buf) => {
          const seq = renderer.applyBinary(buf);
          // After a (re)snapshot, re-apply still-pending optimistic pixels onto
          // the fresh base so a later rollback stays correct (no-op on connect).
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
  }, [slug, showToast]);

  const onCooldown = gauge !== null && gauge.charges <= 0 && gauge.cooldownUntil > Date.now();
  const cooldownSeconds = onCooldown ? Math.max(0, Math.ceil((gauge!.cooldownUntil - Date.now()) / 1000)) : 0;

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
          <button
            type="button"
            className="lp-btn"
            aria-pressed={erasing}
            onClick={() => setErasing((e) => !e)}
          >
            {t("canvas.erase")}
          </button>
        </div>
      </div>

      {toast && (
        <div className={`lp-toast${toast.kind === "cooldown" ? " is-cooldown" : ""}`} role="status">
          {t(toast.messageKey as MessageKey, toast.params)}
        </div>
      )}
    </div>
  );
}
