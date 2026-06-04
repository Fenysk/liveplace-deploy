/**
 * Public player profile page — route `/u/{login}` (F11, FEN-22).
 *
 * Presentational only: all display logic lives in the pure, unit-tested
 * `buildProfileView` (profileView.ts). This component subscribes to the Convex
 * `profiles.getPublicProfile` query and renders the resulting descriptor.
 *
 * No private data is ever requested or rendered — the query returns the
 * allow-listed public shape (CA2); see docs/contracts/profile-read.md.
 *
 * INTEGRATION (pending, tracked on FEN-22):
 *   - `api` requires the Convex package to expose its generated api
 *     (`@canvas/convex/api`) and the `getPublicProfile` query to be wired once
 *     the `profiles` + `userCanvasStats` tables land (FEN-11 / FEN-17).
 *   - `profile.*` message keys must be added to the i18n catalogs (FEN-24) —
 *     listed in the contract.
 *   - Mount under the app router at `/u/:login` (web shell, FEN-16).
 */
import { useQuery } from "convex/react";
import { api } from "@canvas/convex/api";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { buildProfileView } from "./profileView.js";

export interface ProfilePageProps {
  /** Twitch login from the route param; resolution is case-insensitive server-side. */
  login: string;
}

export function ProfilePage({ login }: ProfilePageProps) {
  const t = useTranslate();
  const locale = useLocale();
  const result = useQuery(api.profiles.getPublicProfile, { login });
  const view = buildProfileView(result, locale);

  if (view.state === "loading") {
    return <p className="profile-loading">{t("common.loading")}</p>;
  }
  if (view.state === "notFound") {
    return <p className="profile-notfound">{t(view.titleKey)}</p>;
  }

  return (
    <main className="profile" aria-label={t("nav.profile")}>
      <header className="profile-header">
        {view.avatarUrl ? (
          <img className="profile-avatar" src={view.avatarUrl} alt="" />
        ) : (
          <div className="profile-avatar profile-avatar--placeholder" aria-hidden />
        )}
        <div>
          <h1 className="profile-name">{view.displayName}</h1>
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
              <th>{t("profile.bestRank")}</th>
            </tr>
          </thead>
          <tbody>
            {view.canvases.map((c) => (
              <tr key={c.canvasSlug}>
                {/* maillage (FEN-114): each joined canvas links back to it. */}
                <td>
                  <Link to={paths.canvas(c.canvasSlug)}>{c.canvasTitle}</Link>
                </td>
                <td>{c.pixelsPlaced}</td>
                <td>{c.points}</td>
                <td>{c.bestRank ? t(c.bestRank.key, c.bestRank.params) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
