/**
 * Minimal dependency-free SPA router (FEN-45, shared with FEN-34).
 *
 * The web app had no router — `App.tsx` only carried in-page `#anchor` links, so
 * feature pages (ProfilePage `/u/:login`, GalleryPage `/gallery`) were
 * unreachable by URL. Rather than pull in `react-router-dom` (a stack addition
 * that only the Founding Engineer/Alexis can sign off), this is a ~50-line
 * History-API router: enough for the handful of MVP routes, zero new deps.
 *
 * Page routes are `lazy()`-loaded so the home shell keeps booting even before
 * the Convex generated api (`@canvas/convex/api`) is exposed to the web app
 * (that wiring is owned by Dev Full-stack); only navigating to a gated route
 * pulls in the chunk that needs it. Once the api resolves, those routes render
 * with no further change here.
 *
 * Routing rules:
 *   - `/u/:login`  → <ProfilePage login={param} />. The param is passed through
 *     verbatim (only URL-decoded) — login resolution is case-insensitive
 *     SERVER-side via `profiles.by_login`; never pre-normalize on the client.
 *   - `/gallery`   → <GalleryPage /> (canvas discovery list, FEN-34).
 *   - anything else → the home <App /> shell.
 */
import {
  Suspense,
  lazy,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
} from "react";
import { useTranslate } from "@canvas/i18n/react";
import { App } from "./App.js";

const ProfilePage = lazy(() =>
  import("./features/profile/ProfilePage.js").then((m) => ({ default: m.ProfilePage })),
);
const GalleryPage = lazy(() =>
  import("./features/gallery/GalleryPage.js").then((m) => ({ default: m.GalleryPage })),
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

/**
 * Match a single-segment-param pattern (e.g. `/u/:login`) against a concrete
 * path. Returns the captured params, or `null` when it doesn't match.
 */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSeg = patternSegments[i]!;
    const pathSeg = pathSegments[i]!;
    if (patternSeg.startsWith(":")) {
      params[patternSeg.slice(1)] = pathSeg;
    } else if (patternSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

/** Inline loading state while a lazy route chunk is fetched. */
function RouteFallback(): ReactElement {
  const t = useTranslate();
  return <p className="route-loading">{t("common.loading")}</p>;
}

export function Router(): ReactElement {
  const path = usePathname();

  const profile = matchRoute("/u/:login", path);
  if (profile) {
    // Decode `%xx` (e.g. unusual logins) but DO NOT lower-case — the server
    // resolves login case-insensitively; pre-normalizing here would mask that.
    const login = decodeURIComponent(profile.login!);
    return (
      <Suspense fallback={<RouteFallback />}>
        <ProfilePage login={login} />
      </Suspense>
    );
  }

  if (path === "/gallery") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <GalleryPage />
      </Suspense>
    );
  }

  // Home shell. Unknown paths fall back here for the MVP (no dedicated 404).
  return <App />;
}
