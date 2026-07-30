/**
 * T1 pilot — first file-based TanStack route (FEN-2096).
 * Renders the design-system reference board (StatesBoard) + creator surfaces
 * QA board (StudioStatesBoard). Zero auth/Convex dependency — pure QA surface.
 */
import { createFileRoute } from "@tanstack/react-router";
import { StatesBoard } from "../ui/StatesBoard.js";
import { StudioStatesBoard } from "../features/streamer/StudioStatesBoard.js";

export const Route = createFileRoute("/states")({
  component: StatesRouteComponent,
});

function StatesRouteComponent() {
  return (
    <>
      <StatesBoard />
      <StudioStatesBoard />
    </>
  );
}
