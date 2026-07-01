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
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslate } from "@canvas/i18n/react";
import { AppShell } from "./App.js";
import { Toast } from "./ui/index.js";
import { useAuthErrorToast } from "./auth/useAuthErrorToast.js";
import { usePostLoginRedirect } from "./auth/usePostLoginRedirect.js";
import { resolveRoute, paths, isPseudoSegment, normalizePseudo } from "./routes.js";
import { isObsPath, parseObsView } from "./features/canvas/obs.js";
import { resolveRenderMode } from "./features/canvas/renderMode.js";
import { useObsLateDetect } from "./features/canvas/useObsLateDetect.js";
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


const HomeView = lazy(() =>
  import("./features/home/HomeView.js").then((m) => ({ default: m.HomeView })),
);
const ProfilePage = lazy(() =>
  import("./features/profile/ProfilePage.js").then((m) => ({ default: m.ProfilePage })),
);
const CanvasView = lazy(() =>
  import("./features/canvas/CanvasViewLive.js").then((m) => ({ default: m.CanvasViewLive })),
);
const ObsView = lazy(() =>
  import("./features/canvas/ObsView.js").then((m) => ({ default: m.ObsView })),
);
const ObsViewLive = lazy(() =>
  import("./features/canvas/ObsViewLive.js").then((m) => ({ default: m.ObsViewLive })),
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
 * Canvas hero surface with late-OBS detection (S3 / FEN-1417).
 *
 * Renders CanvasView immediately (R-Perf: no wait screen). If
 * `window.obsstudio` appears within 500 ms after mount — an exotic embedder
 * that injects it late — the component switches to ObsView exactly once
 * (AC10: no re-flash; detection is one-way only).
 *
 * `forceNormal` is true when `?obs=0/false` is present (AC4b / FEN-1427):
 * the late-detect probe result is vetoed so an explicit disable wins even
 * when obsstudio is already injected.
 */
function CanvasRoute({ slug, forceNormal }: { slug: string; forceNormal: boolean }): ReactElement {
  const obsLate = useObsLateDetect();
  if (!forceNormal && obsLate) {
    return (
      <Lazy>
        <ObsViewLive slug={slug} />
      </Lazy>
    );
  }
  return (
    <Lazy>
      <CanvasView slug={slug} />
    </Lazy>
  );
}

function HomeRoute(): ReactElement {
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

/** Route switcher — pure routing logic with no post-login side effects. */
function RouteSwitch(): ReactElement {
  const path = usePathname();

  // OBS browser source (`/obs`, `/{slug}/obs`): read-only transparent overlay,
  // no nav chrome. Matched here BEFORE resolveRoute (which treats it as 404).
  // FEN-1432: use ObsViewLive so an unknown slug shows a blank source instead
  // of the default canvas.
  if (isObsPath(path)) {
    const { slug: obsSlug } = parseObsView(path, window.location.search);
    return (
      <Lazy>
        <ObsViewLive slug={obsSlug} />
      </Lazy>
    );
  }

  // FEN-1160 (C-3): /gallery is now fused into the home page (D-1). SPA replace
  // to canonical / so the URL is clean. Server 301 for hard loads = DevOps ticket.
  if (path === paths.gallery()) {
    replace(paths.home());
    return <></>;
  }

  const route = resolveRoute(path);
  switch (route.kind) {
    case "home":
      return <HomeRoute />;

    case "canvasLegacyRedirect": {
      // FEN-433 (C2): /c/:slug → /:slug (SPA replaceState; server 301 via DevOps).
      // G9 (AC3 v2): if the slug is not a valid Twitch-format pseudo (e.g. contains
      // hyphens), redirecting would produce a generic 404. Instead render CanvasViewLive
      // directly — Convex confirms not-found → canvas-gone StateScreen, not generic 404.
      const normalized = normalizePseudo(route.slug);
      if (!isPseudoSegment(normalized)) {
        return (
          <Lazy>
            <CanvasView slug={normalized} />
          </Lazy>
        );
      }
      // Valid pseudo — redirect to canonical /:slug; router re-renders immediately.
      replace(paths.canvas(normalized));
      return <></>;
    }

    case "canvas": {
      // Synchronous OBS decision before first paint → anti-flash (AC9).
      // FEN-1427 (AC8): OBS mode renders ObsView. FEN-1432: validate the slug
      // via Convex first so an unknown slug shows a blank transparent source
      // instead of the default canvas. ObsViewLive does the Convex check.
      const search = window.location.search;
      const mode = resolveRenderMode({
        pathname: path,
        search,
        userAgent: navigator.userAgent,
        hasObsStudio: typeof window.obsstudio !== "undefined",
      });
      if (mode === "obs") {
        return (
          <Lazy>
            <ObsViewLive slug={route.slug} />
          </Lazy>
        );
      }
      // AC4b (FEN-1427): ?obs=0/false vetoes useObsLateDetect even when
      // window.obsstudio is already present. Reuse the same search string so
      // there is no double-parse on the hot path.
      const obsParam = new URLSearchParams(search).get("obs");
      const forceNormal = obsParam === "0" || obsParam === "false";
      // Normal hero surface — renders bare. CanvasRoute handles the residual
      // case where window.obsstudio is injected late (S3 / FEN-1417, AC3/AC10).
      return <CanvasRoute slug={route.slug} forceNormal={forceNormal} />;
    }
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
    case "studioBroadcastRedirect":
      // FEN-1217: /studio/broadcast/:slug removed; redirect to /studio (CEO Q2).
      replace(paths.studio());
      return <></>;
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

/**
 * App root — mounts the post-login own-canvas redirect (case B / FEN-1472 S2)
 * on top of the route switcher. When the POSTLOGIN_OWNCANVAS_KEY flag is set
 * (user signed in from a non-canvas page) this hook drives an SPA replace to
 * `/{slug}` once the auth:me query settles (AC5). If the slug is null after
 * settle, a neutral info toast appears and the user stays at / (Q3).
 */
export function Router(): ReactElement {
  const t = useTranslate();
  const verdict = usePostLoginRedirect();
  const errorToast = useAuthErrorToast();

  const actedRef = useRef(false);
  const [showFallbackToast, setShowFallbackToast] = useState(false);

  // Execute the verdict side-effect exactly once.
  useEffect(() => {
    if (actedRef.current) return;
    if (verdict.kind === "redirect") {
      actedRef.current = true;
      replace(verdict.path);
    } else if (verdict.kind === "fallback") {
      actedRef.current = true;
      setShowFallbackToast(true);
    }
  }, [verdict]);

  // Auto-dismiss the Q3 fallback toast after 4 s.
  useEffect(() => {
    if (!showFallbackToast) return;
    const id = setTimeout(() => setShowFallbackToast(false), 4_000);
    return () => clearTimeout(id);
  }, [showFallbackToast]);

  return (
    <>
      <RouteSwitch />
      {showFallbackToast && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
          }}
        >
          <Toast
            title={t("auth.postLogin.noCanvas")}
            onClose={() => setShowFallbackToast(false)}
            closeLabel={t("common.close")}
          />
        </div>
      )}
      {errorToast.msgKey && (
        <div className="lp-toast-host">
          <Toast
            kind="error"
            title={t(errorToast.msgKey)}
            onClose={errorToast.dismiss}
            closeLabel={t("canvas.toast.close")}
          />
        </div>
      )}
    </>
  );
}
