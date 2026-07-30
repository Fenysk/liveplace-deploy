/**
 * Convex-aware wrapper for {@link ModPreviewMini} (FEN-2156 E3-C).
 *
 * Owns the `moderation.previewModerationTargets` subscription and feeds
 * the pure {@link ModPreviewMini} component. A local error-boundary catches
 * any `useQuery` throw so the confirm panel stays functional on transient
 * Convex errors (AC-F11).
 *
 * The query runs only while this component is mounted. The parent
 * (`PixelInfoPanel`) calls `renderModPreview` only inside the armed confirm
 * branch, so the subscription is naturally skipped when `modArmed === null`.
 * When `canvasId` is null (pre-auth edge), the creator returns `null` and
 * this component is not mounted (no subscription).
 */
import { Component, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@canvas/convex/api";
import type { Id } from "@canvas/convex/dataModel";
import type { TranslateFn } from "@canvas/i18n";
import { ModPreviewMini } from "./ModPreviewMini.js";
import { PALETTE_HEX } from "./renderer.js";
import type { ModAction } from "./usePixelInspect.js";

const previewModerationTargetsRef = api.moderation.previewModerationTargets;

export interface LiveModPreviewProps {
  canvasId: Id<"canvases">;
  x: number;
  y: number;
  action: ModAction;
  t: TranslateFn;
}

interface ErrorBoundaryProps {
  action: ModAction;
  t: TranslateFn;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ModPreviewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ModPreviewMini
          state="error"
          action={this.props.action}
          paletteHex={PALETTE_HEX}
          t={this.props.t}
        />
      );
    }
    return this.props.children;
  }
}

function LiveModPreviewInner({ canvasId, x, y, action, t }: LiveModPreviewProps): ReactNode {
  const result = useQuery(previewModerationTargetsRef, { canvasId, x, y, action });

  if (result === undefined) {
    return <ModPreviewMini state="loading" action={action} paletteHex={PALETTE_HEX} t={t} />;
  }

  return <ModPreviewMini state="ready" action={action} data={result} paletteHex={PALETTE_HEX} t={t} />;
}

export function LiveModPreview(props: LiveModPreviewProps): ReactNode {
  return (
    <ModPreviewErrorBoundary action={props.action} t={props.t}>
      <LiveModPreviewInner {...props} />
    </ModPreviewErrorBoundary>
  );
}
