/**
 * Dedicated 404 page (FEN-114, G9 Arcade copy FEN-622).
 *
 * Uses the shared `StateScreen` / `StateArt` so the tone, layout, focus
 * management, and a11y are consistent with every other G9 state. Two exits:
 * "Back home" (primary) + "Browse the gallery" (secondary) — no dead-end.
 * Rendered inside `AppShell` so the persistent nav is always present.
 */
import { useTranslate } from "@canvas/i18n/react";
import { StateScreen } from "../ui/StateScreen.js";
import { StateArt } from "../ui/StateArt.js";
import { paths } from "../routes.js";

export function NotFoundPage(): React.ReactElement {
  const t = useTranslate();
  return (
    <StateScreen
      id="notfound"
      title={t("state.404.title")}
      subtitle={t("state.404.sub")}
      art={<StateArt.notFound />}
      primary={{ label: t("state.404.cta1"), href: paths.home() }}
      secondary={{ label: t("state.404.cta2"), href: paths.gallery() }}
    />
  );
}
