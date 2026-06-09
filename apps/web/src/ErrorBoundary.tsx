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
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslate } from "@canvas/i18n/react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** Pure presentational fallback — kept a function so it can use i18n hooks. */
function ErrorFallback({ onRetry }: { onRetry: () => void }): React.ReactElement {
  const t = useTranslate();
  return (
    <div
      role="alert"
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 480,
        margin: "4rem auto",
        padding: "0 1rem",
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>{t("common.error")}</p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          minHeight: 44,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 1rem",
          borderRadius: 8,
          border: "1px solid #ccc",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the error visible for diagnosis even though we recover the UI.
    console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
