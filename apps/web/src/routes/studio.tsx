/**
 * Studio layout route (FEN-2098 T3). AppShell wraps all /studio/* pages.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../App.js";

export const Route = createFileRoute("/studio")({
  component: StudioLayout,
});

function StudioLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
