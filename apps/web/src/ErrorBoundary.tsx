/**
 * App-root error boundary (FEN-182).
 *
 * The web shell mounts a bare React tree with no error boundary, so ANY
 * synchronous render throw — most painfully a `useQuery` that re-throws a Convex
 * error — unmounted the whole app and left a blank white page with no recovery.
 * That is exactly what the post-Twitch-OAuth white screen looked like: an
 * auth-gated query fired before the Convex token was confirmed, threw
 * "unauthenticated", and blanked everything (the root cause is fixed in
 * CanvasViewLive by gating on `useConvexAuth`, but a viewer must never be left
 * staring at a white void if some other transient error slips through).
 *
 * This boundary is the safety net: it catches render-time throws, logs them to
 * the console (so they are still diagnosable), and renders a small, i18n'd
 * recovery surface with a Retry that re-mounts the subtree without a full reload.
 * It is intentionally framework-light (no external deps) and reuses the existing
 * `common.error` / `common.retry` strings so it adds no new i18n catalog surface.
 */
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { useTranslate } from "@canvas/i18n/react";
import {
  attemptChunkReload,
  attemptSoftRetry,
  isChunkLoadError,
  recordBoundaryError,
} from "./chunkReloadGuard.js";
import { StateScreen } from "./ui/StateScreen.js";
import { StateArt } from "./ui/StateArt.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** Error being auto-recovered (soft retry or one-shot reload) — render nothing. */
  recovering: boolean;
}

/** Pure presentational fallback — kept a function so it can use i18n hooks. */
function ErrorFallback({ onRetry }: { onRetry: () => void }): React.ReactElement {
  const t = useTranslate();
  return (
    <StateScreen
      id="error-boundary"
      tone="error"
      kicker={t("state.error.kicker")}
      title={t("state.error.title")}
      subtitle={t("state.error.sub")}
      art={<StateArt.error />}
      primary={{ label: t("state.error.cta1"), onPress: onRetry }}
      secondary={{ label: t("state.error.cta2"), href: "/" }}
    />
  );
}

/**
 * Router-level error surface (`defaultErrorComponent`). Unlike the app-root
 * ErrorBoundary below, a route-scoped error keeps the router alive: Retry
 * resets the boundary and invalidates matches instead of remounting the tree.
 */
export function RouteErrorFallback({ error, reset }: ErrorComponentProps): React.ReactElement | null {
  const router = useRouter();
  // Auto-recovery ladder (FEN-2154 chunk reload, generalised by FEN-2165):
  // render nothing while a recovery attempt is in flight; show the red screen
  // only once every one-shot guard has vetoed (a real, reproducible bug).
  const [recoveryExhausted, setRecoveryExhausted] = useState(false);

  useEffect(() => {
    // Keep the error visible for diagnosis even though the UI recovers.
    console.error("[RouteErrorFallback] caught route error:", error);
    recordBoundaryError("route-boundary", error);
    if (isChunkLoadError(error)) {
      // Stale-deploy chunk failure: one-shot reload fetches the fresh index.html.
      if (!attemptChunkReload()) setRecoveryExhausted(true);
      return;
    }
    // Any other render throw (e.g. a Convex query re-throwing after a long-idle
    // reconnect): one silent boundary reset, then one reload, then the screen.
    if (attemptSoftRetry()) {
      reset();
      void router.invalidate();
      return;
    }
    if (!attemptChunkReload()) setRecoveryExhausted(true);
  }, [error]);

  const handleRetry = (): void => {
    reset();
    void router.invalidate();
  };

  if (!recoveryExhausted) return null;

  return <ErrorFallback onRetry={handleRetry} />;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, recovering: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    // Render nothing (not the red screen) while componentDidCatch decides
    // whether a one-shot recovery is still available (FEN-2154 / FEN-2165).
    return { hasError: true, recovering: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the error visible for diagnosis even though we recover the UI.
    console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
    recordBoundaryError("app-boundary", error);
    if (isChunkLoadError(error)) {
      // Stale-deploy chunk failure: one-shot reload fetches the fresh index.html.
      if (!attemptChunkReload()) this.setState({ recovering: false });
      return;
    }
    // Any other render throw: one silent re-mount of the subtree, then one
    // reload, then the red screen (every guard is one-shot per 30s window).
    if (attemptSoftRetry()) {
      this.setState({ hasError: false, recovering: false });
      return;
    }
    if (!attemptChunkReload()) this.setState({ recovering: false });
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false, recovering: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.state.recovering) return null;
      return <ErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
