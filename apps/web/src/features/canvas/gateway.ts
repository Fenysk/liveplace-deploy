import { CANVAS_QUERY_PARAM } from "@canvas/protocol";

/**
 * Resolve the gateway WS endpoint for a canvas slug.
 *
 * Build-time override `VITE_WS_URL` wins (used in dev / split deployments);
 * otherwise we derive it from the page origin so the bundled client talks to the
 * same host that served it (the Compose/NAS topology terminates TLS and proxies
 * the gateway). The exact path shape is the gateway's; we only assemble the URL,
 * we don't define the wire contract.
 *
 * Path shape (FEN-326 / FEN-441): ALL slugs use the bare **`/ws`** path, because
 * that is the only WS route the Compose/NAS reverse proxy (Caddyfile `@ws path
 * /ws /ws/*`) forwards to the gateway. Emitting `/canvas/{slug}/ws` for non-
 * default slugs fell through to the SPA/static handler, which answered `200`/HTML
 * instead of `101 Switching Protocols`, so the socket never opened (same failure
 * mode as QA FEN-312 / FEN-441). Per-slug WS routing (`/canvas/{slug}/ws`) is a
 * post-MVP proxy concern — DevOps loop when multi-canvas ships.
 *
 * `canvasId` (S0/S3 — FEN-1560): when provided, appended as `?canvas=<canvasId>` so
 * the gateway can serve the correct per-user canvas. Absent → no param → gateway
 * falls back to DEFAULT_CANVAS_ID (retro-compat single-canvas).
 */
export function gatewayWsUrl(slug: string | null, canvasId?: string): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${gatewayWsPath(slug, canvasId)}`;
}

/**
 * Pure slug → WS path (extracted so it's unit-testable without a
 * DOM/`import.meta.env`). ALL slugs → bare `/ws`; the proxy only forwards that
 * path. See {@link gatewayWsUrl} for why.
 *
 * When `canvasId` is provided it is appended as `?canvas=<canvasId>` (S0/S3).
 */
export function gatewayWsPath(_slug: string | null, canvasId?: string): string {
  return canvasId ? `/ws?${CANVAS_QUERY_PARAM}=${encodeURIComponent(canvasId)}` : "/ws";
}
