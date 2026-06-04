/**
 * Minimal dependency-free SPA router (FEN-45; nav shell + 404 in FEN-114).
 *
 * The web app deliberately has no `react-router` (a stack addition only the
 * Founding Engineer/Alexis can sign off). This is a ~50-line History-API router:
 * the reactive `usePathname()` + client-side `<Link>`/`navigate()` primitives,
 * and a `<Router>` that switches on the pure {@link resolveRoute} (routes.ts).
 *
 * Surfaces split into two layouts:
 *   - **Hero** (canvas `/`, `/c/:slug`) and the **OBS overlay** render bare —
 *     the fresco owns the screen (D5: nav is secondary to the canvas-hero).
 *   - **Page** surfaces (gallery, profile, 404) render inside the shared
 *     {@link AppShell} so they carry a persistent global nav and are never an
 *     island/dead-end.
 *
 * Page routes are `lazy()`-loaded so the hero keeps booting regardless of the
 * Convex-backed chunks.
 */
import {
  Suspense,
  lazy,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslate } from "@canvas/i18n/react";
import { AppShell } from "./App.js";
import { resolveRoute } from "./routes.js";
import { isObsPath } from "./features/canvas/obs.js";

const ProfilePage = lazy(() =>
  import("./features/profile/ProfilePage.js").then((m) => ({ default: m.ProfilePage })),
);
const GalleryPage = lazy(() =>
  import("./features/gallery/GalleryPage.js").then((m) => ({ default: m.GalleryPage })),
);
const CanvasView = lazy(() =>
  import("./features/canvas/CanvasViewLive.js").then((m) => ({ default: m.CanvasViewLive })),
);
const ObsView = lazy(() =>
  import("./features/canvas/ObsView.js").then((m) => ({ default: m.ObsView })),
);
const NotFoundPage = lazy(() =>
  import("./features/NotFoundPage.js").then((m) => ({ default: m.NotFoundPage })),
);
const DashboardPage = lazy(() =>
  import("./features/streamer/DashboardPage.js").then((m) => ({ default: m.DashboardPage })),
);
const CreateCanvasPage = lazy(() =>
  import("./features/streamer/CreateCanvasPage.js").then((m) => ({ default: m.CreateCanvasPage })),
);
const BroadcastPage = lazy(() =>
  import("./features/streamer/BroadcastPage.js").then((m) => ({ default: m.BroadcastPage })),
);

/** Subscribe to browser history changes (back/forward + `navigate()`). */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function currentPath(): string {
  return window.location.pathname;
}

/** Reactive `location.pathname`; re-renders the router on navigation. */
export function usePathname(): string {
  // getServerSnapshot returns "/" so SSR/prerender (if ever added) stays inert.
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}

/**
 * Client-side navigation. `pushState` does not emit `popstate`, so we dispatch
 * one to wake every `usePathname()` subscriber.
 */
export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Internal `<a>` that navigates client-side instead of triggering a full reload.
 * Plain-left-clicks (no modifier keys, default target) are intercepted; anything
 * else (new-tab, middle-click, external) falls through to native behaviour.
 */
export function Link({
  to,
  onClick,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>): ReactElement {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }
  return <a href={to} onClick={handleClick} {...rest} />;
}

/** Inline loading state while a lazy route chunk is fetched. */
function RouteFallback(): ReactElement {
  const t = useTranslate();
  return <p className="route-loading">{t("common.loading")}</p>;
}

/** Suspense-wrapped lazy route body. */
function Lazy({ children }: { children: ReactNode }): ReactElement {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

export function Router(): ReactElement {
  const path = usePathname();

  // OBS browser source (`/obs`, `/{slug}/obs`): read-only transparent overlay,
  // no nav chrome. Matched here BEFORE resolveRoute (which treats it as 404).
  if (isObsPath(path)) {
    return (
      <Lazy>
        <ObsView />
      </Lazy>
    );
  }

  const route = resolveRoute(path);
  switch (route.kind) {
    case "canvas":
      // Hero surface — renders bare; its own light topbar carries the gallery link.
      return (
        <Lazy>
          <CanvasView slug={route.slug} />
        </Lazy>
      );
    case "gallery":
      return (
        <AppShell>
          <Lazy>
            <GalleryPage />
          </Lazy>
        </AppShell>
      );
    case "profile":
      return (
        <AppShell>
          <Lazy>
            <ProfilePage login={route.login} />
          </Lazy>
        </AppShell>
      );
    case "studioDashboard":
      return (
        <AppShell>
          <Lazy>
            <DashboardPage />
          </Lazy>
        </AppShell>
      );
    case "studioCreate":
      return (
        <AppShell>
          <Lazy>
            <CreateCanvasPage />
          </Lazy>
        </AppShell>
      );
    case "studioBroadcast":
      return (
        <AppShell>
          <Lazy>
            <BroadcastPage slug={route.slug} />
          </Lazy>
        </AppShell>
      );
    case "notFound":
      return (
        <AppShell>
          <Lazy>
            <NotFoundPage />
          </Lazy>
        </AppShell>
      );
  }
}
