/**
 * /studio → DashboardPage (FEN-2098 T3).
 */
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const DashboardPage = lazy(() =>
  import("../../features/streamer/DashboardPage.js").then((m) => ({ default: m.DashboardPage })),
);

export const Route = createFileRoute("/studio/")({
  component: DashboardRoute,
});

function DashboardRoute() {
  return (
    <Suspense>
      <DashboardPage />
    </Suspense>
  );
}
