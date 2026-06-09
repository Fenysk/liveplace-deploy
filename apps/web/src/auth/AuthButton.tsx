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
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { Button, TwitchGlyph } from "../ui/index.js";
import { Link } from "../router.js";
import { paths } from "../routes.js";
import { authClient, signInWithTwitch, signOut } from "./auth-client";
import "./auth-button.css";

/** `auth:me` → current user + app profile (or null), referenced by name. */
const meRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { profile: { login: string } | null } | null
>("auth:me");

export function AuthButton(): React.ReactElement {
  const t = useTranslate();
  const { data: session, isPending } = authClient.useSession();
  const me = useQuery(meRef, {});

  if (isPending) {
    // Neutral placeholder so the topbar slot keeps its height while the session
    // resolves — it morphs into either the connect CTA or the identity row.
    return (
      <Button variant="secondary" size="md" loading disabled>
        {t("common.loading")}
      </Button>
    );
  }

  if (!session) {
    // The one CTA of the onboarding moment: connect with Twitch (brand-lock).
    return (
      <Button
        className="lp-auth__twitch"
        icon={<TwitchGlyph size={20} />}
        onClick={() => void signInWithTwitch()}
      >
        {t("auth.signIn")}
      </Button>
    );
  }

  const { name, image } = session.user;
  const login = me?.profile?.login ?? null;
  return (
    <span className="lp-auth">
      {image ? (
        <img src={image} alt="" className="lp-auth__avatar" />
      ) : null}
      {login ? (
        <Link
          to={paths.profile(login)}
          className="lp-auth__name ui-focusable"
          aria-label={t("nav.myProfile")}
          title={t("auth.signedInAs", { name })}
        >
          {name}
        </Link>
      ) : (
        <span className="lp-auth__name" title={t("auth.signedInAs", { name })}>
          {name}
        </span>
      )}
      <Button variant="ghost" size="md" onClick={() => void signOut()}>
        {t("auth.signOut")}
      </Button>
    </span>
  );
}
