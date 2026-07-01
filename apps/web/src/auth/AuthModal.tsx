/**
 * Pre-OAuth value modal (FEN-580 / G1 spec §7).
 *
 * Intercepts the Twitch sign-in redirect with a single intermediate screen that
 * answers "Why? What do I get? Is it safe?" in < 2 s — then one button to Twitch.
 *
 * State machine: closed → open → submitting → [OAuth redirect / dismissed → closed]
 * The `open` / `closed` states are owned by the parent (CanvasView); `submitting`
 * is local to this component (the button was clicked, redirect in flight).
 *
 * A11y (spec §E10 / AC7): built on BottomSheet socle (FEN-1330 S2) which provides
 * role="dialog", aria-modal, focus-trap (Tab cycles within), Escape dismiss, and
 * focus-return to triggerEl on close.
 *
 * Anti-dark-patterns (spec §9 / AC9): neutral close label, no countdown, no
 * confirmshaming.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { BottomSheet, Button, TwitchGlyph } from "../ui/index.js";
import { signInWithTwitch } from "./auth-client.js";
import "./auth-modal.css";

export interface AuthModalProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** The OAuth callbackURL to pass to `signInWithTwitch`. */
  callbackURL: string;
  /** AC10: redirect URL on OAuth error; omit to leave Better Auth default. */
  errorCallbackURL?: string;
  /** Canvas streamer slug; null triggers the generic value copy. */
  streamer: string | null;
  /** Element that triggered the modal open — focus is returned here on dismiss. */
  triggerEl: HTMLElement | null;
  /** Called when the modal is dismissed without authenticating. */
  onDismiss: () => void;
  /**
   * Called just before the OAuth redirect starts (after "Continue" is clicked).
   * The parent uses this to persist the batch + intent to sessionStorage.
   */
  onBeforeRedirect: () => void;
}

export function AuthModal({
  open,
  callbackURL,
  errorCallbackURL,
  streamer,
  triggerEl,
  onDismiss,
  onBeforeRedirect,
}: AuthModalProps): React.ReactElement | null {
  const t = useTranslate();
  const titleId = useId();
  const [submitting, setSubmitting] = useState(false);

  // Reset submitting state whenever modal closes (E3: no infinite spinner).
  useEffect(() => {
    if (!open) setSubmitting(false);
  }, [open]);

  const handleContinue = useCallback(() => {
    if (submitting) return; // guard double-submit (E7 / E12)
    setSubmitting(true);
    onBeforeRedirect(); // persist batch + intent to sessionStorage
    void signInWithTwitch({ callbackURL, ...(errorCallbackURL != null ? { errorCallbackURL } : {}) });
  }, [submitting, onBeforeRedirect, callbackURL, errorCallbackURL]);

  const ctaLabel = submitting ? t("auth.modal.cta.redirecting") : t("auth.signIn");

  return (
    <BottomSheet
      open={open}
      onClose={onDismiss}
      presentation="modal"
      desktop="card"
      showHandle
      dragDismiss
      triggerEl={triggerEl}
      titleId={titleId}
      className="lp-auth-modal"
    >
      {/* Close button — neutral label, no confirmshaming (AC9 / E8). Kept as
          alternative to handle drag on mobile and as sole dismiss affordance on
          desktop card (handle hidden at >=1024px). */}
      <button
        type="button"
        className="lp-modal__close ui-focusable"
        aria-label={t("auth.modal.close")}
        onClick={onDismiss}
      >
        ×
      </button>

      <h2 id={titleId} className="lp-modal__title">
        {t("auth.modal.title")}
      </h2>

      <p className="lp-modal__value">
        {streamer
          ? t("auth.modal.value.streamer", { streamer })
          : t("auth.modal.value.generic")}
      </p>

      <p className="lp-modal__reassurance">
        {t("auth.modal.reassurance")}
      </p>

      {/* Single primary action — spec §7: "Pas de seconde action" */}
      <Button
        className="lp-modal__cta lp-auth__twitch"
        icon={<TwitchGlyph size={20} />}
        loading={submitting}
        disabled={submitting}
        onClick={handleContinue}
      >
        {ctaLabel}
      </Button>
    </BottomSheet>
  );
}
