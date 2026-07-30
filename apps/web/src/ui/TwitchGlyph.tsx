import type { ReactElement } from "react";

/**
 * TwitchGlyph (handoff §3.1) — mono SVG that inherits `currentColor`, so the
 * caller controls the colour (brand purple `--twitch-purple` on the connect CTA,
 * white on an accent fill, …). Inlined (not an <img>) so it recolours and stays
 * crisp at any size. Path matches `handoff/svg/twitch.svg`.
 */
export interface TwitchGlyphProps {
  size?: number;
  className?: string;
  title?: string;
}

export function TwitchGlyph({
  size = 20,
  className,
  title = "Twitch",
}: TwitchGlyphProps): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label={title}
      className={className}
    >
      <path d="M4.3 1 2 5.4v14.3h4.9V23h2.7l2.7-3.3h4l5-5V1H4.3zm15 12.1-2.7 2.7h-4.3l-2.3 2.3v-2.3H6.6V2.9h12.7v10.2zM15.6 6.5h-1.8v4.6h1.8V6.5zm-4.6 0H9.2v4.6H11V6.5z" />
    </svg>
  );
}
