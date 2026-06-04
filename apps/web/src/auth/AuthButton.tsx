/**
 * Sign-in / signed-in control (FEN-11 / §F1). Drives off Better Auth's reactive
 * session so it flips between "Sign in with Twitch" and the signed-in identity
 * without a page load. All strings go through i18n (FR↔EN). Sign-out is reactive
 * too (no hard reload) — the session flips to anonymous in place (FEN-115).
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
import { Link } from "../router.js";
import { paths } from "../routes.js";
import { authClient, signInWithTwitch, signOut } from "./auth-client";

/**
 * ≥44×44px tap-target floor for the auth control (FEN-125 / WCAG 2.5.5). The
 * native button/link glyphs are below the touch minimum on a phone; this gives
 * each interactive element a full-size hit area. Fine visuals stay delegated.
 */
const controlTapStyle: React.CSSProperties = {
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
};

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
    return (
      <button type="button" disabled style={controlTapStyle}>
        {t("common.loading")}
      </button>
    );
  }

  if (!session) {
    return (
      <button type="button" onClick={() => void signInWithTwitch()} style={controlTapStyle}>
        {t("auth.signIn")}
      </button>
    );
  }

  const { name, image } = session.user;
  const login = me?.profile?.login ?? null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      {image ? (
        <img
          src={image}
          alt=""
          width={24}
          height={24}
          style={{ borderRadius: "50%" }}
        />
      ) : null}
      {login ? (
        <Link
          to={paths.profile(login)}
          aria-label={t("nav.myProfile")}
          title={t("auth.signedInAs", { name })}
          style={{ ...controlTapStyle, padding: "0 0.25rem" }}
        >
          {name}
        </Link>
      ) : (
        <span title={t("auth.signedInAs", { name })}>{name}</span>
      )}
      <button type="button" onClick={() => void signOut()} style={controlTapStyle}>
        {t("auth.signOut")}
      </button>
    </span>
  );
}
