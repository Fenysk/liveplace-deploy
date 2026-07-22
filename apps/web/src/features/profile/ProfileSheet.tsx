/**
 * ProfileSheet — bottom sheet modale profil (FEN-1967 / C-2).
 *
 * Rendu unique dans <Router> à l'intérieur de <ProfileSheetProvider>.
 * Ouvert par `openProfile(login)`, fermé par `closeProfile()`.
 *
 * Contenu : même markup que ProfilePage + section isMe avec lien canvas perso.
 * Le bouton "Supprimer mon compte" arrive en S4 (FEN-1969), PAS ici.
 */
import { useQuery } from "convex/react";
import { api } from "@canvas/convex/api";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import { BottomSheet } from "../../ui/BottomSheet.js";
import { Link } from "@tanstack/react-router";
import { buttonClass } from "../../ui/variants.js";
import { buildProfileView } from "./profileView.js";
import { useProfileSheet } from "./profileSheetStore.js";
import "./profile.css";

const TITLE_ID = "lp-profile-sheet-title";

const meRef = api.auth.me;

export function ProfileSheet(): React.ReactElement | null {
  const { login, closeProfile } = useProfileSheet();
  const t = useTranslate();
  const locale = useLocale();

  // Convex query skippée si aucun profil ouvert.
  const result = useQuery(
    api.profiles.getPublicProfile,
    login !== null ? { login } : "skip",
  );
  const me = useQuery(meRef, {});

  const view = buildProfileView(login !== null ? result : undefined, locale);

  // isMe : comparaison insensible à la casse (login Twitch = lowercase mais soyons robustes).
  const isMe =
    login !== null &&
    me?.profile?.login != null &&
    me.profile.login.toLowerCase() === login.toLowerCase();

  const personalCanvasSlug = me?.personalCanvasSlug ?? null;

  return (
    <BottomSheet
      open={login !== null}
      onClose={closeProfile}
      presentation="modal"
      titleId={view.state === "ready" ? TITLE_ID : undefined}
      ariaLabel={view.state !== "ready" ? t("nav.profile") : undefined}
    >
      {view.state === "loading" && (
        <p className="profile-loading">{t("common.loading")}</p>
      )}

      {view.state === "notFound" && (
        <section className="profile-notfound" aria-labelledby="lp-profile-sheet-notfound">
          <h2 id="lp-profile-sheet-notfound">{t(view.titleKey)}</h2>
          <p>{t("profile.notFound.body")}</p>
          <div className="profile-notfound__actions">
            <Link
              to="/"
              className={buttonClass("primary", "md")}
              onClick={closeProfile}
            >
              {t("profile.notFound.cta")}
            </Link>
          </div>
        </section>
      )}

      {view.state === "ready" && (
        <div className="profile profile--sheet">
          <header className="profile-header">
            {view.avatarUrl ? (
              <img className="profile-avatar" src={view.avatarUrl} alt="" />
            ) : (
              <div className="profile-avatar profile-avatar--placeholder" aria-hidden />
            )}
            <div>
              <h2 id={TITLE_ID} className="profile-name">{view.displayName}</h2>
              <p className="profile-login">@{view.login}</p>
              <p className="profile-since">
                {t(view.memberSinceKey, view.memberSinceParams)}
              </p>
            </div>
          </header>

          <section className="profile-totals" aria-label={t("profile.totals")}>
            <dl>
              <div>
                <dt>{t("profile.pixelsPlaced")}</dt>
                <dd>{view.totals.pixelsPlaced}</dd>
              </div>
              <div>
                <dt>{t("profile.points")}</dt>
                <dd>{view.totals.points}</dd>
              </div>
              <div>
                <dt>{t("profile.canvasesJoined")}</dt>
                <dd>{view.totals.canvasesJoined}</dd>
              </div>
            </dl>
          </section>

          {view.isEmpty ? (
            <p className="profile-empty">{t(view.emptyKey)}</p>
          ) : (
            <table className="profile-canvases">
              <thead>
                <tr>
                  <th>{t("profile.canvas")}</th>
                  <th>{t("profile.pixelsPlaced")}</th>
                  <th>{t("profile.points")}</th>
                </tr>
              </thead>
              <tbody>
                {view.canvases.map((c) => (
                  <tr key={c.canvasSlug}>
                    <td>
                      <Link
                        to="/$pseudo"
                        params={{ pseudo: c.canvasSlug }}
                        onClick={closeProfile}
                      >
                        {c.canvasTitle}
                      </Link>
                    </td>
                    <td>{c.pixelsPlaced}</td>
                    <td>{c.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {isMe && personalCanvasSlug && (
            <section className="profile-my-account">
              <Link
                to="/$pseudo"
                params={{ pseudo: personalCanvasSlug }}
                className={buttonClass("secondary", "md")}
                onClick={closeProfile}
              >
                {t("profile.myCanvas")}
              </Link>
            </section>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
