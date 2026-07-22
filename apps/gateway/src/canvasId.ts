/**
 * Canvas-id extraction + validation for the WS upgrade path (S0/S1 — FEN-1560).
 *
 * The client sends `?canvas=<canvasId>` on the upgrade URL. This module
 * centralises the parse so the gateway and its tests import from one place.
 */
import { type IncomingMessage } from "node:http";
import { CANVAS_QUERY_PARAM, isValidCanvasId } from "@canvas/protocol";
import { DEFAULT_CANVAS_ID, parseCanvasDeltaChannel } from "@canvas/redis-scripts";

// Re-export so gateway internals (pubsub.ts, gateway.ts) can import from here
// without a breaking change; the canonical definition now lives in @canvas/redis-scripts
// co-located with canvasDeltaChannel (N8).
export { parseCanvasDeltaChannel };

/** Thrown when the `?canvas=` param is present but fails the allowlist check. */
export class CanvasIdError extends Error {
  readonly statusCode = 400;
  constructor(raw: string) {
    super(`invalid canvasId: "${raw}"`);
    this.name = "CanvasIdError";
  }
}

/**
 * Extract the canvasId from a WS upgrade request.
 * - `?canvas=<valid>` → the id
 * - absent → DEFAULT_CANVAS_ID (retro-compat single-canvas / local smoke)
 * - `?canvas=<invalid>` → throws CanvasIdError (upgrade should be rejected 400)
 */
export function extractCanvasId(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  const raw = url.searchParams.get(CANVAS_QUERY_PARAM);
  if (raw === null) return DEFAULT_CANVAS_ID;
  if (!isValidCanvasId(raw)) throw new CanvasIdError(raw);
  return raw;
}

/** Pull the JWT from the upgrade request: `?token=`, then `Authorization: Bearer`. */
export function extractToken(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return undefined;
}
