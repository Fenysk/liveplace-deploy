/**
 * Legacy `/c/$slug` route — FEN-2097 T2, G9 AC3.
 *
 * If the slug is a valid pseudo, redirect (replace) to `/$slug` (canonical).
 * Otherwise render CanvasViewLive directly — keeps the legacy path working for
 * slugs that don't follow the Twitch pseudo format.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { isPseudoSegment, normalizePseudo } from "../routes.js";
import "../features/canvas/canvas.css";

const CanvasViewLive = lazy(() =>
  import("../features/canvas/CanvasViewLive.js").then((m) => ({
    default: m.CanvasViewLive,
  })),
);

export const Route = createFileRoute("/c/$slug")({
  beforeLoad: ({ params }) => {
    const normalized = normalizePseudo(params.slug);
    if (isPseudoSegment(normalized)) {
      throw redirect({ to: "/$pseudo", params: { pseudo: normalized }, replace: true });
    }
    // Not a valid pseudo → fall through to component (direct CanvasViewLive render)
  },
  component: CLegacySlugComponent,
});

function CLegacySlugComponent() {
  const { slug } = Route.useParams();
  const normalized = normalizePseudo(slug);
  const t = useTranslate();
  return (
    <Suspense fallback={<p className="route-loading">{t("common.loading")}</p>}>
      <CanvasViewLive slug={normalized} />
    </Suspense>
  );
}
