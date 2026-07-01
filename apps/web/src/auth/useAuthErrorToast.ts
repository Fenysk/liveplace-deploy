/**
 * Auth error toast hook (FEN-1474 · S4).
 *
 * Reads ?error= on first mount, resolves it to an i18n key, strips the param
 * from the URL via replaceState (user stays on the original page — AC10), and
 * exposes state consumed by the AppShell to render a Toast.
 */
import { useState, useEffect } from "react";

type AuthErrorKey = "auth.error.cancelled" | "auth.error.failed";

/**
 * Map a raw `?error=` value to an i18n key.
 * `access_denied` = user cancelled the Twitch OAuth prompt.
 * Everything else = generic sign-in failure.
 * Exported for unit testing.
 */
export function errorKeyFromParam(error: string | null): AuthErrorKey | null {
  if (!error) return null;
  return error === "access_denied" ? "auth.error.cancelled" : "auth.error.failed";
}

/** Strip the `error` key from a URLSearchParams and return the serialized string. */
function withoutError(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("error");
  return params.toString();
}

export interface AuthErrorToast {
  msgKey: AuthErrorKey | null;
  dismiss: () => void;
}

/**
 * Detect a ?error= query param on mount, show an i18n toast, and clean the URL.
 * Call once at the AppShell level so every page-surface route is covered.
 */
export function useAuthErrorToast(): AuthErrorToast {
  const [msgKey, setMsgKey] = useState<AuthErrorKey | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const key = errorKeyFromParam(params.get("error"));
    if (!key) return;

    const qs = withoutError(window.location.search);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    setMsgKey(key);
  }, []);

  return { msgKey, dismiss: () => setMsgKey(null) };
}
