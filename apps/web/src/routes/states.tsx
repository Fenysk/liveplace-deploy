/**
 * T1 pilot — first file-based TanStack route (FEN-2096).
 * Renders the design-system reference board (StatesBoard) + creator surfaces
 * QA board (StudioStatesBoard). Zero auth/Convex dependency — pure QA surface.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const StatesBoard = lazy(() =>
  import("../ui/StatesBoard.js").then((m) => ({ default: m.StatesBoard })),
);
const StudioStatesBoard = lazy(() =>
  import("../features/streamer/StudioStatesBoard.js").then((m) => ({
    default: m.StudioStatesBoard,
  })),
);

export const Route = createFileRoute("/states")({
  component: StatesRouteComponent,
});

function StatesRouteComponent() {
  return (
    <Suspense>
      <StatesBoard />
      <StudioStatesBoard />
    </Suspense>
  );
}
