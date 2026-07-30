/**
 * /studio/new → CreateCanvasPage (FEN-2098 T3).
 */
import { createFileRoute } from "@tanstack/react-router";
import { CreateCanvasPage } from "../../features/streamer/CreateCanvasPage.js";

export const Route = createFileRoute("/studio/new")({
  component: CreateCanvasPage,
});
