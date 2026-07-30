import type { ReactElement } from "react";
import { wordmarkClass, type SizeToken } from "./variants.js";

/**
 * Wordmark (handoff §3.1 / AC11) — the LivePlace brand lockup: the "live pixel"
 * mark + the word, with "Place" carrying the coral accent. Renders in the
 * display face (`--font-display` = Press Start 2P under `data-direction="fun"`),
 * the ONE place (besides the celebration headline) the display font is allowed.
 */
export interface WordmarkProps {
  size?: SizeToken;
  className?: string;
}

export function Wordmark({ size = "md", className }: WordmarkProps): ReactElement {
  return (
    <span
      className={className ? `${wordmarkClass(size)} ${className}` : wordmarkClass(size)}
      role="img"
      aria-label="LivePlace"
    >
      <span className="ui-wordmark__mark" aria-hidden="true" />
      <span aria-hidden="true">
        Live<span className="ui-wordmark__accent">Place</span>
      </span>
    </span>
  );
}
