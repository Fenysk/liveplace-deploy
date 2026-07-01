/**
 * The Convex → gateway internal-POST seam, shared by every action that pushes a
 * Redis side-effect to the gateway (moderation in `moderation.ts`, the F6 gauge
 * claim in `points.ts`). The "read GATEWAY_INTERNAL_URL/SECRET, strip the
 * trailing slash, POST a Bearer JSON body, throw on !ok, degrade gracefully when
 * unset" envelope was written twice (audit finding 1g); it lives here once.
 *
 * Only ever invoked from inside Convex actions (where `fetch` is available);
 * Convex never touches Redis directly (guardrail G-A1), so this HTTP hop is how
 * durable decisions reach the hot path.
 */
export interface DispatchResult {
  /** False when the gateway is not configured (URL unset) — the call was a no-op. */
  dispatched: boolean;
  /** Human-readable outcome for logs/audit. */
  detail: string;
  /** `version` echoed by the gateway (moderation overwrite version), when present. */
  version?: number;
}

/**
 * POST a JSON body to a gateway `/internal/*` route. Returns
 * `{ dispatched: false }` (no throw) when `GATEWAY_INTERNAL_URL` is unset, so
 * callers degrade to "durable state only" in local/anon smoke; throws when the
 * gateway is configured but rejects the request.
 */
export async function gatewayPost(path: string, body: unknown): Promise<DispatchResult> {
  const base = process.env.GATEWAY_INTERNAL_URL;
  if (!base) return { dispatched: false, detail: "gateway_not_configured" };
  const secret = process.env.GATEWAY_INTERNAL_SECRET;
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gateway_dispatch_failed ${path}: ${res.status} ${text}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as { version?: number };
  return { dispatched: true, detail: `gateway ${res.status} ${path}`, version: json.version };
}
