import type { ReactElement } from "react";
import { pillClass, pillIcon, type PillState } from "./variants.js";

/**
 * StatusPill (handoff §3.1 / AC4) — canvas state in 5 variants
 * (open · cooldown · frozen · ended · error). Always icon + label, never colour
 * alone, so it reads in B&W / for colour-blind users. The label is caller-
 * supplied (i18n FR/EN lives in the screens, not the design system).
 */
export interface StatusPillProps {
  state: PillState;
  label: string;
  className?: string;
}

export function StatusPill({ state, label, className }: StatusPillProps): ReactElement {
  return (
    <span className={className ? `${pillClass(state)} ${className}` : pillClass(state)}>
      <span className="ui-pill__icon" aria-hidden="true">
        {pillIcon(state)}
      </span>
      {label}
    </span>
  );
}
