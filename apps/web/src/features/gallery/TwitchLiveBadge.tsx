/**
 * Blinking purple live badge (FEN-2132).
 *
 * Reuses gallery__statusDot + gallery__statusLabel CSS classes so the visual
 * is pixel-identical to the badge shown on gallery cards. Imports gallery.css
 * as a side-effect so the styles are present even when rendered outside the
 * gallery route (e.g. the canvas header).
 *
 * Wraps the badge in an `<a>` pointing to twitch.tv/<twitchLogin> so it is
 * always clickable (desktop: new tab; mobile: deeplink to the Twitch app).
 */
import type { TranslateFn } from "@canvas/i18n";
import "./gallery.css";

export function TwitchLiveBadge({
  twitchLogin,
  t,
}: {
  twitchLogin: string;
  t: TranslateFn;
}) {
  const label = t("gallery.status.live");
  return (
    <a
      href={`https://twitch.tv/${twitchLogin}`}
      target="_blank"
      rel="noopener noreferrer"
      className="lp-navlink"
      style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
      aria-label={label}
    >
      <span className="gallery__statusDot" data-live="true" aria-hidden />
      <span className="gallery__statusLabel">{label}</span>
    </a>
  );
}
