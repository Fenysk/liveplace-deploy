/**
 * Convex-aware container for {@link CanvasView} (Lot D / FEN-142). Keeps the
 * interactive surface itself free of any Convex import (see tierClaim.ts: the
 * live adapter is wired here, outside CanvasView) while supplying the live
 * "claim de palier" source once the viewer is authed on a real canvas.
 *
 * Responsibilities:
 *   - resolve the slug → Convex canvas id (`canvases.getCanvasBySlug`; the bare
 *     `/ws` route maps to the `"default"` canvas, mirroring the gateway);
 *   - gate on Convex's confirmed auth state (`useConvexAuth`) — `getMyTierProgress`/
 *     `claimTier` are auth-gated server-side, so we pass `canvasId = null` until the
 *     Convex backend has validated the JWT, which makes the live source degrade to
 *     inert (no progression UI for anonymous viewers, claims no-op). Gating on the
 *     raw Better Auth session instead raced the token handshake and blanked the
 *     page after the OAuth redirect (FEN-182);
 *   - own the Convex hooks (`useQuery`/`useAction`) and feed the pure
 *     {@link createLiveTierSource} bridge, returning a referentially STABLE source
 *     so CanvasView subscribes exactly once.
 *
 * Functions are referenced BY NAME via `makeFunctionReference` (same decoupled
 * convention as DashboardPage / GalleryPage), so the web build stays independent
 * of generated Convex codegen.
 */
import { useEffect, useRef, useState } from "react";
import { useAction, useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { CanvasView } from "./CanvasView.js";
import { makeWsTicketResolver } from "./wsTicket.js";
import { fetchConvexToken, getAuthHint } from "../../auth/auth-client.js";
import {
  createLiveTierSource,
  type ClaimTierFn,
  type LiveTierSource,
} from "./liveTierSource.js";
import {
  createLivePixelAuthorSource,
  type PixelAuthorResult,
} from "./livePixelAuthorSource.js";
import {
  createLiveModerationSource,
  type AuthorAtResult,
  type CellActionResult,
} from "./liveModerationSource.js";
import type { PixelAuthorSource } from "./pixelInfo.js";
import type { ModerationSource } from "./moderationSource.js";
import type { TierProgress, TierSource } from "./tierClaim.js";
import { StateScreen } from "../../ui/StateScreen.js";
import { StateArt } from "../../ui/StateArt.js";
import { paths } from "../../routes.js";

/** `canvases.getCanvasBySlug({ slug }) → canvas | null` (public; we only need the id). */
const getCanvasBySlugRef = makeFunctionReference<
  "query",
  { slug: string },
  { _id: string } | null
>("canvases:getCanvasBySlug");

/**
 * FEN-433 (AC-1 / C5) — idempotent safety-net: ensure the personal canvas
 * exists for the current user. Called once after Convex confirms auth.
 */
const ensurePersonalCanvasRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { canvasId: string; slug: string; created: boolean } | null
>("canvases:ensurePersonalCanvas");

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
 * `canvases.pixelAuthor({ canvasId, x, y }) → { author }` (FEN-296). PUBLIC,
 * read-only, off the pose hot-path: resolves the public Twitch login of a cell's
 * top-of-stack pixel (or `null` for never-posed / erased / anonymous / no
 * profile). Powers the pixel-info panel's "placed by" line (FEN-297).
 */
const pixelAuthorRef = makeFunctionReference<
  "query",
  { canvasId: string; x: number; y: number },
  PixelAuthorResult
>("canvases:pixelAuthor");

// ── Pixel-click moderation (FEN-754 §8.2) — the F8 moderation layer (FEN-52). ──

/** `moderation.canModerate({ canvasId }) → boolean` — owner/mod gate, non-throwing. */
const canModerateRef = makeFunctionReference<"query", { canvasId: string }, boolean>(
  "moderation:canModerate",
);

/** `moderation.amOwner({ canvasId }) → boolean` — owner-strict gate (FEN-1174 / S0 R1). */
const amOwnerRef = makeFunctionReference<"query", { canvasId: string }, boolean>(
  "moderation:amOwner",
);

/** `moderation.deletePixels({ canvasId, cells }) → CellActionResult` (S8.3). */
const deletePixelsRef = makeFunctionReference<
  "action",
  { canvasId: string; cells: Array<{ x: number; y: number }> },
  CellActionResult
>("moderation:deletePixels");

/** `moderation.deleteGroupAt({ canvasId, x, y }) → CellActionResult` (S8.4 / G2). */
const deleteGroupAtRef = makeFunctionReference<
  "action",
  { canvasId: string; x: number; y: number },
  CellActionResult
>("moderation:deleteGroupAt");

/** `moderation.authorAt({ canvasId, x, y }) → AuthorAtResult | null` — ban target. */
const authorAtRef = makeFunctionReference<
  "query",
  { canvasId: string; x: number; y: number },
  AuthorAtResult | null
>("moderation:authorAt");

/** `moderation.banAndWipe({ canvasId, targetUserId }) → CellActionResult` (S8.5). */
const banAndWipeRef = makeFunctionReference<
  "action",
  { canvasId: string; targetUserId: string },
  CellActionResult
>("moderation:banAndWipe");

/**
 * React hook: a referentially STABLE {@link ModerationSource} backed by the F8
 * moderation actions/queries, mirroring {@link usePixelAuthorSource}. Bound
 * actions/queries are read through refs so a late-resolving auth/canvas is
 * honoured without rebuilding the source. `canvasId` is the auth-gated id (mod
 * actions require identity server-side); a `null` id degrades every action to a
 * no-op (the panel never shows them unless `canModerate` is true anyway).
 */
function useModerationSource(canvasId: string | null): ModerationSource {
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const convex = useConvex();
  const deletePixels = useAction(deletePixelsRef);
  const deleteGroupAt = useAction(deleteGroupAtRef);
  const banAndWipe = useAction(banAndWipeRef);
  const deletePixelsRefHook = useRef(deletePixels);
  deletePixelsRefHook.current = deletePixels;
  const deleteGroupAtRefHook = useRef(deleteGroupAt);
  deleteGroupAtRefHook.current = deleteGroupAt;
  const banAndWipeRefHook = useRef(banAndWipe);
  banAndWipeRefHook.current = banAndWipe;

  const sourceRef = useRef<ModerationSource | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = createLiveModerationSource({
      getCanvasId: () => canvasIdRef.current,
      deletePixels: (args) => deletePixelsRefHook.current(args),
      deleteGroupAt: (args) => deleteGroupAtRefHook.current(args),
      authorAt: (args) => convex.query(authorAtRef, args),
      banAndWipe: (args) => banAndWipeRefHook.current(args),
    });
  }
  return sourceRef.current;
}

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

/**
 * React hook: a referentially STABLE {@link PixelAuthorSource} backed by the
 * public `canvases:pixelAuthor` query. The Convex client (`useConvex`) is stable
 * for the app's lifetime, and the live canvas id is read through a ref so a
 * late-resolving slug is honoured without rebuilding the source. `canvasId` is
 * the PUBLIC canvas id (NOT auth-gated) — anonymous viewers can inspect a pixel's
 * author too; the query degrades to `null` (panel: "author unavailable") while it
 * is null.
 */
function usePixelAuthorSource(canvasId: string | null): PixelAuthorSource {
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const convex = useConvex();
  const sourceRef = useRef<PixelAuthorSource | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = createLivePixelAuthorSource({
      getCanvasId: () => canvasIdRef.current,
      query: (args) => convex.query(pixelAuthorRef, args),
    });
  }
  return sourceRef.current;
}

export interface CanvasViewLiveProps {
  /** Canvas slug (required — FEN-433: no default canvas). */
  slug: string;
}

export function CanvasViewLive({ slug }: CanvasViewLiveProps): React.ReactElement | null {
  // Gate the auth-only progression query on Convex's OWN auth state, not on the
  // Better Auth session (FEN-182). After the Twitch OAuth redirect, Better Auth's
  // `useSession()` flips to authenticated ~1s before the Convex client has fetched
  // its JWT and had the backend confirm it. `getMyTierProgress` calls
  // `requireUserId` server-side, so firing it during that window threw
  // "unauthenticated"; with no error boundary that synchronous `useQuery` throw
  // unmounted the whole tree → white page (matching "renders ~1s then white", also
  // on reload). `useConvexAuth().isAuthenticated` is true only once the Convex
  // backend has validated the token (see ConvexProviderWithAuth), so the query can
  // never run unauthenticated. The ErrorBoundary at the app root is the matching
  // safety net for any other transient render throw.
  const { isAuthenticated: convexAuthed, isLoading: convexLoading } = useConvexAuth();
  const t = useTranslate();

  // FEN-957: optimistic hint to suppress the dock Twitch CTA while Convex auth
  // is still loading for a browser that previously had a session. Read once at
  // mount from localStorage (same hint AuthButton.tsx writes). While loading AND
  // hint is set, authPending=true — CanvasView hides the CTA. Once isLoading
  // flips to false the truth is known regardless of the hint, so the CTA appears
  // (or stays hidden if the user is actually authed). Stale hints (expired token)
  // resolve gracefully: loading ends → authPending=false → CTA shows.
  const [authHint] = useState(() => getAuthHint());
  const authPending = convexLoading && authHint;

  // FEN-433 (AC-1 / C5) — idempotent safety-net for accounts that existed before
  // the personal-canvas feature. Called once after Convex confirms auth so that
  // every user has a canvas even if the account.onCreate trigger was missed.
  //
  // FEN-1471: track in-flight state so the canvas===null guard below can
  // suppress the not-found screen during the R1 race window (post-login redirect
  // arrives before ensurePersonalCanvas has committed the row).
  const [ensurePending, setEnsurePending] = useState(false);
  const ensurePersonalCanvas = useMutation(ensurePersonalCanvasRef);
  const calledEnsureRef = useRef(false);
  useEffect(() => {
    if (convexAuthed && !calledEnsureRef.current) {
      calledEnsureRef.current = true;
      setEnsurePending(true);
      void ensurePersonalCanvas({}).finally(() => setEnsurePending(false));
    }
    if (!convexAuthed) {
      calledEnsureRef.current = false;
    }
  }, [convexAuthed, ensurePersonalCanvas]);

  // The canvas socket carries the Convex JWT so the gateway resolves `userId` and
  // serves the per-user `gauge` that ungates placement (FEN-184; regression guard
  // FEN-267). Gate the token on Convex's CONFIRMED auth (not the Better Auth
  // session, which flips ~1s early — FEN-182). A STABLE resolver that reads the
  // live auth through a ref: CanvasView binds it once, and `convexAuthed` below
  // drives the reconnect that re-runs it the instant auth flips.
  const convexAuthedRef = useRef(convexAuthed);
  convexAuthedRef.current = convexAuthed;
  const fetchTicketRef = useRef(
    makeWsTicketResolver(() => convexAuthedRef.current, fetchConvexToken),
  );

  // Public query — resolves for anonymous viewers too, but we only arm the live
  // tier source once Convex itself is authed (the progression queries require
  // identity server-side).
  const canvas = useQuery(getCanvasBySlugRef, { slug });
  const canvasId = convexAuthed && canvas ? canvas._id : null;

  const tierSource = useLiveTierSource(canvasId);

  // Pixel-author attribution is PUBLIC (FEN-296) — anonymous viewers can inspect
  // a cell's author, so it reads the canvas id WITHOUT the auth gate that fences
  // the progression queries above.
  const publicCanvasId = canvas ? canvas._id : null;
  const pixelAuthorSource = usePixelAuthorSource(publicCanvasId);

  // Pixel-click moderation (FEN-754 §8.2). The gate query is auth-gated (mods are
  // signed-in), so it rides the auth-gated `canvasId`; the live source binds the
  // F8 actions. The panel only exposes the actions when `canModerate` is true.
  const canModerate = useQuery(canModerateRef, canvasId ? { canvasId } : "skip") === true;
  // FEN-1192: amOwner uses optionalUserId (non-throwing for unauthenticated users,
  // returns false). Subscribing with publicCanvasId (not auth-gated canvasId) means
  // the subscription exists before Convex auth settles — Convex will push `true`
  // reactively the moment auth is confirmed, so the Studio entry appears in the open
  // burger without waiting for an extra React render cycle (canvasId → subscription
  // → undefined → true). Avoids the mobile timing gap where the user opens the menu
  // before convexAuthed is true and never sees the entry update.
  const isCanvasOwner =
    useQuery(amOwnerRef, publicCanvasId ? { canvasId: publicCanvasId } : "skip") === true;
  const moderationSource = useModerationSource(canvasId);

  // FEN-1432 anti-flash guard: while Convex hasn't confirmed whether the canvas
  // exists, hold off mounting CanvasView (which would open the WS and briefly
  // show the default canvas). canvas===undefined = still loading; null = gone.
  if (canvas === undefined) return null;

  // G9 (AC3): canvas definitively not found — show StateScreen here, BEFORE
  // CanvasView mounts. This avoids the WS connecting to a non-existent canvas and
  // prevents the canvas-layout CSS (.lp-app) from wrapping the state screen (which
  // caused the "page blanche" regression in QA FEN-624).
  if (canvas === null) {
    // FEN-1471 (R1 guard): while Convex auth is still settling or
    // ensurePersonalCanvas is in-flight, the personal canvas may not exist yet
    // in the DB — suppress the not-found screen. getCanvasBySlug will push the
    // canvas reactively once the mutation commits. Once both have settled and
    // canvas is still null, it is genuinely not found.
    if (convexLoading || (convexAuthed && ensurePending)) return null;

    return (
      <StateScreen
        id="canvas-gone"
        kicker={t("state.canvas.kicker")}
        title={t("state.canvas.title")}
        subtitle={t("state.canvas.sub")}
        art={<StateArt.canvasGone />}
        primary={{ label: t("state.canvas.cta1"), href: paths.gallery() }}
        secondary={{ label: t("state.canvas.cta2"), href: paths.home() }}
      />
    );
  }

  return (
    <CanvasView
      slug={slug}
      tierSource={tierSource}
      pixelAuthorSource={pixelAuthorSource}
      canModerate={canModerate}
      moderationSource={moderationSource}
      fetchTicket={fetchTicketRef.current}
      convexAuthed={convexAuthed}
      authPending={authPending}
      isCanvasOwner={isCanvasOwner}
    />
  );
}
