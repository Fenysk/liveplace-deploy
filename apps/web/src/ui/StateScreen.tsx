/**
 * Full-page state screen (G9, FEN-622).
 *
 * Reusable surface for all empty/error/404 states: kicker (Press Start 2P),
 * pixel-art motif, h1 title, subtitle, and up to 2 exit CTA buttons. Every
 * string is injected by the caller (all i18n stays outside this component).
 *
 * Design contract (UI handoff §1):
 *   - Two exits max: primary (accent Button) + secondary (secondary Button).
 *   - `tone="error"` colours the kicker in --status-error-fg.
 *   - Focus lands on the primary exit at mount (`autoFocusPrimary`).
 *   - `aria-labelledby` links the section to the h1 for region navigation.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { buttonClass } from "./variants.js";

export interface StateScreenAction {
  label: string;
  /** Use for client-side navigation (renders a `<Link>`). */
  href?: string;
  /** Use for programmatic actions (renders a `<button>`). */
  onPress?: () => void;
}

export interface StateScreenProps {
  /** Short over-title in `--font-display` (Press Start 2P in Arcade). */
  kicker?: string;
  /** Page h1 — required. Announced as the region label. */
  title: string;
  /** One-sentence reassurance. */
  subtitle?: string;
  /** Decorative pixel-art motif node (`StateArt.*`). */
  art?: ReactNode;
  /** Primary contextual exit — accent button. */
  primary?: StateScreenAction;
  /** Universal escape hatch — secondary button, equal weight. */
  secondary?: StateScreenAction;
  /** `error` colours the kicker red. Default: `neutral`. */
  tone?: "neutral" | "error";
  /** Prefix for generated ARIA ids. Defaults to `"state-screen"`. */
  id?: string;
  /** Auto-focus the primary action on mount (default: true). */
  autoFocusPrimary?: boolean;
}

function clientNavigate(router: ReturnType<typeof useRouter>, href: string, e: React.MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  router.history.push(href);
}

export function StateScreen({
  kicker,
  title,
  subtitle,
  art,
  primary,
  secondary,
  tone = "neutral",
  id = "state-screen",
  autoFocusPrimary = true,
}: StateScreenProps): ReactElement {
  const router = useRouter();
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoFocusPrimary) return;
    const el = actionsRef.current?.querySelector<HTMLElement>(
      "a[href],button:not([disabled])",
    );
    el?.focus();
  }, [autoFocusPrimary]);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`ui-state-screen${tone === "error" ? " ui-state-screen--error" : ""}`}
    >
      {kicker && <p className="ui-state-screen__kicker">{kicker}</p>}
      {art && <div className="ui-state-screen__art" aria-hidden="true">{art}</div>}
      <h1 id={`${id}-title`} className="ui-state-screen__title">
        {title}
      </h1>
      {subtitle && <p className="ui-state-screen__sub">{subtitle}</p>}
      {(primary ?? secondary) && (
        <div className="ui-state-screen__actions" ref={actionsRef}>
          {primary &&
            (primary.href ? (
              <a
                href={primary.href}
                className={buttonClass("primary", "md")}
                onClick={(e) => clientNavigate(router, primary.href!, e)}
              >
                {primary.label}
              </a>
            ) : (
              <button
                type="button"
                className={buttonClass("primary", "md")}
                onClick={primary.onPress}
              >
                {primary.label}
              </button>
            ))}
          {secondary &&
            (secondary.href ? (
              <a
                href={secondary.href}
                className={buttonClass("secondary", "md")}
                onClick={(e) => clientNavigate(router, secondary.href!, e)}
              >
                {secondary.label}
              </a>
            ) : (
              <button
                type="button"
                className={buttonClass("secondary", "md")}
                onClick={secondary.onPress}
              >
                {secondary.label}
              </button>
            ))}
        </div>
      )}
    </section>
  );
}
