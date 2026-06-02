/**
 * Sign-in / signed-in control (FEN-11 / §F1). Drives off Better Auth's reactive
 * session so it flips between "Sign in with Twitch" and the signed-in identity
 * without a page load. All strings go through i18n (FR↔EN). Sign-out triggers a
 * reload so the app returns to the anonymous state (R2b / CA6).
 */
import { useTranslate } from "@canvas/i18n/react";
import { authClient, signInWithTwitch, signOutAndReload } from "./auth-client";

export function AuthButton(): React.ReactElement {
  const t = useTranslate();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <button type="button" disabled>
        {t("common.loading")}
      </button>
    );
  }

  if (!session) {
    return (
      <button type="button" onClick={() => void signInWithTwitch()}>
        {t("auth.signIn")}
      </button>
    );
  }

  const { name, image } = session.user;
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
      <span title={t("auth.signedInAs", { name })}>{name}</span>
      <button type="button" onClick={() => void signOutAndReload()}>
        {t("auth.signOut")}
      </button>
    </span>
  );
}
