/**
 * "Partager" button (FEN-304, Étape 3) — copies the current canvas's public
 * `/c/:slug` link to the clipboard and gives feedback ON the button itself
 * (label flips "Partager" → "Lien copié !"), reverting after ~2 s. Built on the
 * Arcade design-system {@link Button} (the one button definition) and the pure
 * {@link ./share} logic (URL build + no-throw clipboard fallback).
 *
 * Accessibility / robustness (acceptance FEN-302):
 *   - AC1/AC4: a real `<button type="button">` — focusable, keyboard-operable,
 *     never an anchor, never navigates/reloads.
 *   - AC5/AC6: the success label is a synchronous React state flip, auto-reset
 *     to idle after {@link RESET_MS}.
 *   - AC7: a persistent `aria-live="polite"` region announces the outcome to
 *     screen readers (not visual-only).
 *   - AC8: on a clipboard failure the state goes to `error`, the message is
 *     shown AND the link is surfaced in a read-only, auto-selected field for a
 *     manual copy — no crash on any path.
 *   - AC9: a SINGLE state enum + a cleared/re-armed timer make repeated clicks
 *     coherent (no stacked toasts / states).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { Button } from "../../ui/index.js";
import { buildShareUrl, copyToClipboard } from "./share.js";

/** How long the copied/error feedback stays before reverting to idle (AC6). */
const RESET_MS = 2000;

/** The ONE transient state — never a list, so feedback can't stack (AC9). */
type ShareState = "idle" | "copied" | "error";

export interface ShareButtonProps {
  /** Canvas slug; null targets the default canvas (link → `${origin}/`). */
  slug: string | null;
}

export function ShareButton({ slug }: ShareButtonProps): React.ReactElement {
  const t = useTranslate();
  const [state, setState] = useState<ShareState>("idle");
  /** Link shown in the manual-copy field on the error path (AC8). */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  // Clear any pending reset on unmount so we never setState on a gone node.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  // When the manual fallback appears, pre-select the link so a hand-copy is one
  // gesture (Ctrl/Cmd-C).
  useEffect(() => {
    if (state === "error" && manualUrl !== null) manualInputRef.current?.select();
  }, [state, manualUrl]);

  const armReset = useCallback(() => {
    // Re-arming clears the in-flight timer first → spam = clean reset, no stack.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setState("idle");
      setManualUrl(null);
      timerRef.current = null;
    }, RESET_MS);
  }, []);

  const onShare = useCallback(async () => {
    const url = buildShareUrl(window.location.origin, slug);
    const outcome = await copyToClipboard(url);
    if (outcome === "copied") {
      setState("copied");
      setManualUrl(null);
    } else {
      setState("error");
      setManualUrl(url);
    }
    armReset();
  }, [slug, armReset]);

  const label = state === "copied" ? t("canvas.share.copied") : t("canvas.share.label");
  // Polite SR announcement: success message on copy, the manual-copy hint on
  // error, empty when idle (the persistent region only re-announces on change).
  const announce =
    state === "copied"
      ? t("canvas.share.copied")
      : state === "error"
        ? t("canvas.share.error")
        : "";

  return (
    <span className="lp-share">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={t("canvas.share.aria")}
        data-state={state}
        onClick={onShare}
      >
        {label}
      </Button>

      {/* AC8 — manual-copy fallback: visible message + selectable link field. */}
      {state === "error" && manualUrl !== null && (
        <span className="lp-share-fallback">
          <span className="lp-share-error">{t("canvas.share.error")}</span>
          <input
            ref={manualInputRef}
            className="lp-share-url"
            type="text"
            readOnly
            value={manualUrl}
            aria-label={t("canvas.share.aria")}
            onFocus={(e) => e.currentTarget.select()}
          />
        </span>
      )}

      {/* AC7 — persistent polite live region; only its text changes, so SRs
          announce each outcome exactly once. */}
      <span className="ui-sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </span>
    </span>
  );
}
