/**
 * Resolve the gateway WS endpoint for a canvas slug.
 *
 * Build-time override `VITE_WS_URL` wins (used in dev / split deployments);
 * otherwise we derive it from the page origin so the bundled client talks to the
 * same host that served it (the Compose/NAS topology terminates TLS and proxies
 * `/canvas/{slug}/ws` to the gateway). The exact path shape is the gateway's;
 * we only assemble the URL, we don't define the wire contract.
 */
export function gatewayWsUrl(slug: string | null): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const path = slug ? `/canvas/${slug}/ws` : "/ws";
  return `${proto}//${location.host}${path}`;
}
