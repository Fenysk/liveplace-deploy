/**
 * Domain error codes (D2-R7). All ConvexError throws in convex/ import from here;
 * values are frozen for client compatibility.
 */
export const ERRORS = {
  // Canvas lifecycle — canvases.ts
  CANVAS_NOT_FOUND: "canvas_not_found",
  CANVAS_ARCHIVED: "canvas_archived",
  SLUG_RESERVED: "slug_reserved",
  SLUG_TAKEN: "slug_taken",
  // Moderation — moderation.ts
  FORBIDDEN: "forbidden",
  OWNER_TWITCH_UNKNOWN: "owner_twitch_unknown",
  TWITCH_TOKEN_UNAVAILABLE: "twitch_token_unavailable",
  TWITCH_CLIENT_ID_UNSET: "twitch_client_id_unset",
  TWITCH_HELIX_FAILED: "twitch_helix_failed",
  // Auth — lib/identity.ts + auth.ts
  UNAUTHENTICATED: "unauthenticated",
  TWITCH_NO_REFRESH_TOKEN: "twitch_no_refresh_token",
  TWITCH_REFRESH_MISSING_CREDENTIALS: "twitch_refresh_missing_credentials",
  TWITCH_REFRESH_FAILED: "twitch_refresh_failed",
  // Points — points.ts
  INVALID_CONFIG: "invalid_config",
  // Canvas rules — lib/canvasRules.ts (N7)
  INVALID_DIMENSIONS: "invalid_dimensions",
  INVALID_TITLE: "invalid_title",
  INVALID_SLUG: "invalid_slug",
  INVALID_EVENT_WINDOW: "invalid_event_window",
  NOT_OWNER: "not_owner",
} as const;
