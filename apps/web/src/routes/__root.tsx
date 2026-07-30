import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { AppShell } from "../App.js";
import { ProfileSheet } from "../features/profile/ProfileSheet.js";
import { ProfileSheetProvider } from "../features/profile/profileSheetStore.js";

const NotFoundPage = lazy(() =>
  import("../features/NotFoundPage.js").then((m) => ({ default: m.NotFoundPage })),
);

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  return (
    <ProfileSheetProvider>
      {/* ProfileSheet rendu une fois, accessible depuis toutes les surfaces */}
      <ProfileSheet />
      <Outlet />
    </ProfileSheetProvider>
  );
}

function NotFoundComponent() {
  return (
    <AppShell>
      <Suspense>
        <NotFoundPage />
      </Suspense>
    </AppShell>
  );
}
