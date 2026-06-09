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
  useEffect,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { AppShell } from "./App.js";
import { resolveRoute, paths } from "./routes.js";
import { isObsPath } from "./features/canvas/obs.js";
// The canvas screen is the LANDING page (`/`, `/c/:slug`) and the OBS overlay.
// Its layout/positioning sheet (.lp-* → fixed topbar/dock/onboarding) MUST be
// render-blocking, not async-injected: when it rode the lazy canvas chunk's CSS
// it could be missing on first paint (a transient 503 / preload race left every
// chrome element in normal flow, stacked top-left — QA FEN-312 / FEN-326). Pull
// it into the entry graph here (router is in the eager entry chunk) so it ships
// in the blocking `index-*.css` and the hero is never unstyled. The same import
// still lives next to its feature (CanvasView/ObsView/CrisisSelector) for
// authoring; Vite dedupes to the entry. All selectors are `.lp-*`-namespaced, so
// loading it on page routes (gallery/profile/studio) costs ~9 KB and leaks nothing.
import "./features/canvas/canvas.css";

// FEN-433 (C3): `me` query reference for the home-page auth redirect.
const meRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { personalCanvasSlug: string | null } | null
>("auth:me");

const HomeView = lazy(() =>
  import("./features/home/HomeView.js").then((m) => ({ default: m.HomeView })),
);
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
const StatesBoard = lazy(() =>
  import("./ui/StatesBoard.js").then((m) => ({ default: m.StatesBoard })),
);
// Lot C creator surfaces in populated states (mock data, no auth/Convex) — the
// pre-merge QA capture surface (FEN-276), appended below the foundation board.
const StudioStatesBoard = lazy(() =>
  import("./features/streamer/StudioStatesBoard.js").then((m) => ({
    default: m.StudioStatesBoard,
  })),
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
 * Replace the current history entry and re-render (used for redirects that
 * should not create a back-stack entry, e.g. legacy `/c/:slug` → `/:slug`).
 */
export function replace(to: string): void {
  if (to === window.location.pathname) return;
  window.history.replaceState(null, "", to);
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

/**
 * FEN-433 (AC-3 / C3) — Home route handler.
 * Authenticated users are redirected to their personal canvas (`/:slug`).
 * Anonymous visitors see the HomeView hero.
 */
function HomeRoute(): ReactElement {
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(meRef, isAuthenticated ? {} : "skip");

  // Redirect to personal canvas once we have the slug.
  useEffect(() => {
    if (me?.personalCanvasSlug) {
      replace(paths.canvas(me.personalCanvasSlug));
    }
  }, [me]);

  // If authed but slug not loaded yet, show loading; otherwise show HomeView.
  return (
    <Lazy>
      <HomeView />
    </Lazy>
  );
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
    case "home":
      // FEN-433 (C3): home redirects authed users to personal canvas; anon → HomeView.
      return <HomeRoute />;

    case "canvasLegacyRedirect": {
      // FEN-433 (C2): /c/:slug → /:slug (SPA replaceState; server 301 via DevOps).
      // Render nothing while the replace fires; the router re-renders immediately.
      replace(paths.canvas(route.slug));
      return <></>;
    }

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
    case "statesBoard":
      // Design-system reference board (FEN-268). Renders bare — it owns the
      // screen and carries its own surface, like the canvas hero.
      return (
        <Lazy>
          <StatesBoard />
          <StudioStatesBoard />
        </Lazy>
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
