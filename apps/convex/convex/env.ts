// Central access point for all Convex server-side env vars (D2-R8).
// No guard here — callers guard at usage site.
// process.env is available in the Convex runtime; this module-level ambient
// declaration satisfies TS in environments where @types/node is not installed.
declare const process: { env: Record<string, string | undefined> };

export const SITE_URL = process.env.SITE_URL;
export const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;
export const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
export const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
export const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
export const GATEWAY_INTERNAL_URL = process.env.GATEWAY_INTERNAL_URL;
export const GATEWAY_INTERNAL_SECRET = process.env.GATEWAY_INTERNAL_SECRET;
