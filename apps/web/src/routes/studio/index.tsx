/**
 * /studio → DashboardPage (FEN-2098 T3).
 */
import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "../../features/streamer/DashboardPage.js";

export const Route = createFileRoute("/studio/")({
  component: DashboardPage,
});
