/**
 * Sign-in / signed-in control (FEN-11 / §F1). Drives off Better Auth's reactive
 * session so it flips between "Sign in with Twitch" and the signed-in identity
 * without a page load. All strings go through i18n (FR↔EN). Sign-out is reactive
 * too (no hard reload) — the session flips to anonymous in place (FEN-115).
 *
 * Arcade refit (FEN-270, Lot B — "le moment de connexion Twitch"): the connect
 * CTA is the Foundation `Button` atom + `TwitchGlyph`, brand-locked to Twitch
 * purple via the `--twitch-purple` token (AC1/AC2/AC6) — no hand-styled button,
 * no inline values. Sign-out is a low-emphasis `Button` (ghost); the loading
 * slot is a neutral `Button` so the chrome never jumps. All look lives in the
 * token-only `auth-button.css`.
 *
 * Maillage (FEN-114): the signed-in name links to the player's own public
 * profile (`/u/:login`). The Twitch `login` slug is NOT carried on the Better
 * Auth session (deliberately — see apps/convex/convex/auth.ts), so we read it
 * from the `auth:me` query, referenced BY NAME (same decoupled convention as the
 * gallery, so the web build stays independent of generated Convex codegen).
 * Until `login` resolves (loading / anonymous / Convex unset) the name renders
 * as plain text — never a broken link.
 */
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { Button, TwitchGlyph } from "../ui/index.js";
import { Link } from "../router.js";
import { paths } from "../routes.js";
import { authClient, signInWithTwitch, signOut, getAuthHint, setAuthHint } from "./auth-client";
import { classifyOrigin, markPostLoginOwnCanvas, sanitizeReturnTo } from "./returnTo";
import "./auth-button.css";

/** `auth:me` → current user + app profile (or null), referenced by name. */
const meRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { profile: { login: string } | null; personalCanvasSlug: string | null } | null
>("auth:me");

export interface AuthButtonProps {
  /**
   * Optional override for the sign-in action (FEN-580). When provided and the
   * user is unauthenticated, clicking calls this instead of going directly to
   * `signInWithTwitch`. Used by CanvasView to open the pre-OAuth value modal.
   * When absent (e.g. HomeView, StudioPage), the button redirects directly.
   */
  onSignIn?: () => void;
}

export function AuthButton({ onSignIn }: AuthButtonProps = {}): React.ReactElement {
  const t = useTranslate();
  const { data: session, isPending } = authClient.useSession();
  const me = useQuery(meRef, {});

  // Optimistic auth hint: read once at mount from localStorage.  When the
  // stored hint says "was authed", we treat the slot as loading until the
  // session actually resolves — this prevents the Twitch login CTA from
  // flashing during the Better Auth session fetch on page reload (FEN-910).
  const [authHint, setAuthHintState] = useState<boolean>(() => getAuthHint());

  // Sync the persisted hint and the local state whenever the session settles.
  useEffect(() => {
    if (isPending) return;
    const authed = session != null;
    setAuthHint(authed);
    setAuthHintState(authed);
  }, [isPending, session]);

  // Three-state auth status derived from live session + pending flag + hint:
  //   loading       → Better Auth hasn't resolved yet OR hint says expect session
  //   authenticated → session confirmed
  //   anonymous     → confirmed no session (hint cleared / never set)
  const authStatus =
    session != null
      ? "authenticated"
      : isPending || authHint
      ? "loading"
      : "anonymous";

  if (authStatus === "loading") {
    // Neutral placeholder so the topbar slot keeps its height while the session
    // resolves — it morphs into either the connect CTA or the identity row.
    return (
      <Button variant="secondary" size="md" loading disabled>
        {t("common.loading")}
      </Button>
    );
  }

  if (authStatus === "anonymous") {
    // The one CTA of the onboarding moment: connect with Twitch (brand-lock).
    // When `onSignIn` is provided (canvas context), open the value modal first
    // instead of redirecting immediately (FEN-580 T2 trigger).
    return (
      <Button
        className="lp-auth__twitch"
        icon={<TwitchGlyph size={20} />}
        onClick={() => {
          if (onSignIn) { onSignIn(); return; }
          const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
          const origin = classifyOrigin(pathname);
          let callbackURL: string;
          if (origin.case === "A") {
            callbackURL = origin.canvasPath;
          } else {
            markPostLoginOwnCanvas();
            callbackURL = "/";
          }
          void signInWithTwitch({ callbackURL, errorCallbackURL: sanitizeReturnTo(pathname) ?? "/" });
        }}
      >
        {t("auth.signIn")}
      </Button>
    );
  }

  // authStatus === "authenticated" implies session != null (see authStatus derivation above).
  const { name, image } = session!.user;
  const canvasSlug = me?.personalCanvasSlug ?? null;

  const identityContent = (
    <>
      {image ? <img src={image} alt="" className="lp-auth__avatar" /> : null}
      <span className="lp-auth__name">{name}</span>
    </>
  );

  return (
    <span className="lp-auth">
      {canvasSlug ? (
        <Link
          to={paths.canvas(canvasSlug)}
          className="lp-auth__identity lp-auth__canvas-link ui-focusable"
          aria-label={t("nav.openCanvasOf", { name })}
          title={t("nav.openCanvasOf", { name })}
        >
          {identityContent}
        </Link>
      ) : (
        <span
          className="lp-auth__identity"
          title={t("auth.signedInAs", { name })}
        >
          {identityContent}
        </span>
      )}
      <Button variant="ghost" size="md" className="lp-auth__signout" onClick={() => void signOut()}>
        {t("auth.signOut")}
      </Button>
    </span>
  );
}
