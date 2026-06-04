/**
 * Convex-aware container for {@link CanvasView} (Lot D / FEN-142). Keeps the
 * interactive surface itself free of any Convex import (see tierClaim.ts: the
 * live adapter is wired here, outside CanvasView) while supplying the live
 * "claim de palier" source once the viewer is authed on a real canvas.
 *
 * Responsibilities:
 *   - resolve the slug → Convex canvas id (`canvases.getCanvasBySlug`; the bare
 *     `/ws` route maps to the `"default"` canvas, mirroring the gateway);
 *   - gate on the Better Auth session — `getMyTierProgress`/`claimTier` are
 *     auth-gated server-side, so we pass `canvasId = null` until signed in, which
 *     makes the live source degrade to inert (no progression UI for anonymous
 *     viewers, claims no-op);
 *   - own the Convex hooks (`useQuery`/`useAction`) and feed the pure
 *     {@link createLiveTierSource} bridge, returning a referentially STABLE source
 *     so CanvasView subscribes exactly once.
 *
 * Functions are referenced BY NAME via `makeFunctionReference` (same decoupled
 * convention as DashboardPage / GalleryPage), so the web build stays independent
 * of generated Convex codegen.
 */
import { useEffect, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { authClient } from "../../auth/auth-client";
import { CanvasView } from "./CanvasView.js";
import {
  createLiveTierSource,
  type ClaimTierFn,
  type LiveTierSource,
} from "./liveTierSource.js";
import type { TierProgress, TierSource } from "./tierClaim.js";

/** The default canvas slug — mirrors `DEFAULT_CANVAS_SLUG` in apps/convex (ADR-0003). */
const DEFAULT_CANVAS_SLUG = "default";

/** `canvases.getCanvasBySlug({ slug }) → canvas | null` (public; we only need the id). */
const getCanvasBySlugRef = makeFunctionReference<
  "query",
  { slug: string },
  { _id: string } | null
>("canvases:getCanvasBySlug");

/** `points.getMyTierProgress({ canvasId }) → { earned, confirmed }` (both monotonic). */
const getMyTierProgressRef = makeFunctionReference<
  "query",
  { canvasId: string },
  TierProgress
>("points:getMyTierProgress");

/** `points.claimTier({ canvasId, tierIndex }) → { gaugeMaxBonus }` (idempotent by index). */
const claimTierRef = makeFunctionReference<
  "action",
  { canvasId: string; tierIndex: number },
  { gaugeMaxBonus: number }
>("points:claimTier");

/**
 * React hook: a live {@link TierSource} for `canvasId` (or `null` until authed on a
 * real canvas, in which case it degrades to inert — no snapshots, claims no-op).
 * The `getMyTierProgress` subscription is skipped while `canvasId` is null (the
 * query is auth-gated server-side). The returned source identity is stable for the
 * hook's lifetime so the consumer subscribes exactly once; the live id and bound
 * action are read through refs so a late-arriving auth/canvas is honoured without
 * rebuilding the source.
 */
function useLiveTierSource(canvasId: string | null): TierSource {
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const claimAction = useAction(claimTierRef) as ClaimTierFn;
  const claimRef = useRef<ClaimTierFn>(claimAction);
  claimRef.current = claimAction;

  const sourceRef = useRef<LiveTierSource | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = createLiveTierSource({
      getCanvasId: () => canvasIdRef.current,
      claimTier: (args) => claimRef.current(args),
    });
  }

  // Live subscription; "skip" while auth-gated (signed out / no canvas resolved).
  const progress = useQuery(getMyTierProgressRef, canvasId ? { canvasId } : "skip");
  useEffect(() => {
    sourceRef.current?.push(progress);
  }, [progress]);

  return sourceRef.current;
}

export interface CanvasViewLiveProps {
  /** Canvas slug; null targets the default canvas (`/ws`). */
  slug?: string | null;
}

export function CanvasViewLive({ slug = null }: CanvasViewLiveProps): React.ReactElement {
  const { data: session } = authClient.useSession();
  const authed = session != null;

  // Public query — resolves for anonymous viewers too, but we only arm the live
  // tier source once authed (the progression queries require identity server-side).
  const canvas = useQuery(getCanvasBySlugRef, { slug: slug ?? DEFAULT_CANVAS_SLUG });
  const canvasId = authed && canvas ? canvas._id : null;

  const tierSource = useLiveTierSource(canvasId);

  return <CanvasView slug={slug} tierSource={tierSource} />;
}
