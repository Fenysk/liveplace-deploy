import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { useTranslate } from "@canvas/i18n/react";

const HomeView = lazy(() =>
  import("../features/home/HomeView.js").then((m) => ({ default: m.HomeView })),
);

export const Route = createFileRoute("/")({
  component: HomeRouteComponent,
});

function HomeRouteComponent() {
  const t = useTranslate();
  return (
    <Suspense fallback={<p className="route-loading">{t("common.loading")}</p>}>
      <HomeView />
    </Suspense>
  );
}
