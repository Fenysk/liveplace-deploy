// Twitch glyph — the official wordless mark, drawn as inline SVG so it inherits
// currentColor (one asset, recolourable per context). Used on the connect CTA.
export default function TwitchGlyph({ size = 18, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M4.3 1 2 5.4v14.3h4.9V23h2.7l2.7-3.3h4l5-5V1H4.3zm15 12.1-2.7 2.7h-4.3l-2.3 2.3v-2.3H6.6V2.9h12.7v10.2zM15.6 6.5h-1.8v4.6h1.8V6.5zm-4.6 0H9.2v4.6H11V6.5z"/>
    </svg>
  );
}
