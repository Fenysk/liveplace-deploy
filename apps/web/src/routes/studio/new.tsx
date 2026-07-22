/**
 * /studio/new → CreateCanvasPage (FEN-2098 T3).
 */
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const CreateCanvasPage = lazy(() =>
  import("../../features/streamer/CreateCanvasPage.js").then((m) => ({ default: m.CreateCanvasPage })),
);

export const Route = createFileRoute("/studio/new")({
  component: CreateRoute,
});

function CreateRoute() {
  return (
    <Suspense>
      <CreateCanvasPage />
    </Suspense>
  );
}
