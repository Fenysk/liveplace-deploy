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
 *
 * FEN-1515: mounted in main.tsx ABOVE ConvexAuthProvider (a boundary only catches
 * its descendants), so throws from the Convex/Better-Auth provider layer while it
 * processes a brand-new account's first-login session — the last uncovered path
 * that produced a persistent white void — now land here too. The caught error's
 * message is captured into state and surfaced in a collapsed "technical details"
 * disclosure so a reproduction (QA / streamer) yields the exact error without
 * needing the browser console.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { StateScreen } from "./ui/StateScreen.js";
import { StateArt } from "./ui/StateArt.js";
import { paths } from "./routes.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** Message of the caught error, surfaced for diagnosis (FEN-1515). */
  message?: string;
}

/** Pure presentational fallback — kept a function so it can use i18n hooks. */
function ErrorFallback({
  onRetry,
  message,
}: {
  onRetry: () => void;
  message?: string;
}): React.ReactElement {
  const t = useTranslate();
  return (
    <>
      <StateScreen
        id="error-boundary"
        tone="error"
        kicker={t("state.error.kicker")}
        title={t("state.error.title")}
        subtitle={t("state.error.sub")}
        art={<StateArt.error />}
        primary={{ label: t("state.error.cta1"), onPress: onRetry }}
        secondary={{ label: t("state.error.cta2"), href: paths.home() }}
      />
      {message && (
        // Collapsed by default; opt-in disclosure so a reproduction surfaces the
        // exact error without the browser console (FEN-1515 AC1). Muted + centred
        // so it never competes with the recovery CTAs above.
        <details
          style={{
            maxWidth: 480,
            margin: "0.5rem auto 1.5rem",
            padding: "0 1rem",
            textAlign: "center",
            color: "#6b7280",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          <summary style={{ cursor: "pointer" }}>{t("state.error.details")}</summary>
          <code style={{ display: "block", marginTop: 8, wordBreak: "break-word" }}>
            {message}
          </code>
        </details>
      )}
    </>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the error visible for diagnosis even though we recover the UI.
    console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false, message: undefined });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} message={this.state.message} />;
    }
    return this.props.children;
  }
}
