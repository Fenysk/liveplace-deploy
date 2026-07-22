/**
 * Direct Twitch OAuth token refresh (FEN-1765 / B8).
 * Used as a fallback when Better Auth's getValidAccessToken wraps the real
 * Twitch error into a generic FAILED_TO_GET_ACCESS_TOKEN.
 */
import { ConvexError } from "convex/values";
import { ERRORS } from "../errors";
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from "../env";

export interface TwitchTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
}

/**
 * Call Twitch's token endpoint directly with a stored refresh token.
 * Throws ConvexError on missing credentials or non-2xx response.
 */
export async function refreshTwitchTokenDirect(
  storedRefreshToken: string,
): Promise<TwitchTokenResponse> {
  const clientId = TWITCH_CLIENT_ID;
  const clientSecret = TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConvexError(ERRORS.TWITCH_REFRESH_MISSING_CREDENTIALS);
  }

  const resp = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedRefreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => "");
    throw new ConvexError(`${ERRORS.TWITCH_REFRESH_FAILED}: HTTP ${resp.status} ${errorBody}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
  };
}
