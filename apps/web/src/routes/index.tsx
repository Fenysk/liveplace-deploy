import { createFileRoute } from "@tanstack/react-router";
import { HomeView } from "../features/home/HomeView.js";

export const Route = createFileRoute("/")({
  component: HomeView,
});
