/**
 * Streamer dashboard — "Mes canvas" (FEN-120 / Lot H, WF-5, flow S1 entry).
 *
 * The streamer's home base: ONE active canvas promoted to the top (its live
 * status, visibility and "Live now" badge answer F11 "what's online right now"),
 * with the read-only archives listed below. From the active card the streamer
 * reaches Broadcast (OBS, WF-7) in one click, and drives the crisis surface
 * inline (emergency freeze / reopen + grouped ban/wipe — Lot I / FEN-121, via the
 * audit-logged `moderation:setFrozen`). Archives can be reactivated
 * (`activateCanvas`, one-active invariant enforced server-side).
 *
 * Presentation only: the active/archives split, status keys and empty-state all
 * come from the pure `buildDashboardView` (studioView.ts, unit-tested). Convex
 * functions are referenced BY NAME (same decoupled convention as GalleryPage /
 * AuthButton), so the web build stays independent of generated codegen. Strings
 * go through `t(...)` for FR↔EN parity. The look is the Arcade design system
 * (FEN-268): shared Button / StatusPill / EmptyState + `ui-card` surface, tokens
 * only — no hard-coded value or local component (FEN-271, Lot C / AC1, AC6).
 */
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useLocale, useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client";
import { Link, navigate } from "../../router.js";
import { paths } from "../../routes.js";
import { Button, EmptyState, StatusPill, buttonClass } from "../../ui/index.js";
import {
  buildDashboardView,
  type ArchiveRowView,
  type ActiveCanvasView,
  type StreamerCanvas,
} from "./studioView.js";
import { CrisisPanel } from "./CrisisPanel.js";
import { CrisisController } from "./CrisisController.js";
import type { CrisisActionId } from "./crisisView.js";
import "./studio.css";

/** Raw `canvases:listMyCanvases` row (the subset the dashboard renders). */
interface CanvasDoc {
  _id: string;
  slug: string;
  title: string;
  status: "active" | "archived";
  placementOpen: boolean;
  isPublic: boolean;
  width: number;
  height: number;
  viewerCount?: number;
  createdAt: number;
  archivedAt?: number | null;
}

const listMyCanvases = makeFunctionReference<"query", Record<string, never>, CanvasDoc[]>(
  "canvases:listMyCanvases",
);
const activateCanvas = makeFunctionReference<"mutation", { canvasId: string }, null>(
  "canvases:activateCanvas",
);
// Emergency freeze is the audit-logged moderation action (Lot I / FEN-121 backend
// contract): a crisis freeze writes the audit log and forces the gateway
// `canvas:frozen` flag — heavier than a casual `canvases:setPlacementOpen` toggle.
const setFrozen = makeFunctionReference<
  "action",
  { canvasId: string; frozen: boolean },
  { frozen: boolean; dispatched: boolean; detail: string }
>("moderation:setFrozen");

/** LocalStorage flag for the one-time first-crisis freeze hint (D9 persistence). */
const FREEZE_HINT_KEY = "lp.crisis.freezeHintSeen";
function readFreezeHintSeen(): boolean {
  try {
    return localStorage.getItem(FREEZE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Project a Convex doc onto the React-free shape the view-model operates over. */
function toStreamerCanvas(doc: CanvasDoc): StreamerCanvas {
  return {
    id: doc._id,
    slug: doc.slug,
    title: doc.title,
    status: doc.status,
    placementOpen: doc.placementOpen,
    isPublic: doc.isPublic,
    width: doc.width,
    height: doc.height,
    viewerCount: doc.viewerCount ?? 0,
    createdAt: doc.createdAt,
    archivedAt: doc.archivedAt ?? null,
  };
}

export function DashboardPage(): React.ReactElement {
  const t = useTranslate();
  const { data: session, isPending } = authClient.useSession();
  const isSignedIn = !!session;

  // Skip the auth-gated query entirely until signed in (it would otherwise throw
  // `requireUserId`); `"skip"` is Convex's official no-subscription sentinel.
  const docs = useQuery(listMyCanvases, isSignedIn ? {} : "skip");
  const activate = useMutation(activateCanvas);
  const freeze = useAction(setFrozen);

  // Polite SR announcement for freeze/reopen + reactivate (S9 / FEN-143). These
  // mutations only re-render a label, which screen readers don't announce; an
  // aria-live region gives non-visual users the same confirmation the page does.
  const [announce, setAnnounce] = useState("");

  // Crisis panel state (Lot I / FEN-121): which crisis action is dispatching (so
  // its button disables — idempotency guard), and the persisted one-time freeze
  // hint flag (D9 "vu mémorisé").
  const [pendingCrisis, setPendingCrisis] = useState<CrisisActionId | null>(null);
  const [freezeHintSeen, setFreezeHintSeen] = useState(readFreezeHintSeen);
  // Which crisis selection surface is open (ban / wipe), or null. Driven by the
  // CrisisPanel's grouped tools; the CrisisController owns the surface + dispatch.
  const [crisisMode, setCrisisMode] = useState<"ban" | "wipe" | null>(null);

  const view = buildDashboardView(
    docs?.map(toStreamerCanvas),
    { isSignedIn: isSignedIn && !isPending },
  );
  const activeTitle = view.state === "ready" ? view.active?.canvas.title ?? null : null;

  /**
   * Emergency freeze / reopen on the active canvas (Lot I / FEN-121). Routes
   * through the audit-logged `moderation:setFrozen` (the crisis contract), marks
   * the matching crisis button pending while in flight, persists the one-time
   * freeze hint as "seen" the first time the streamer freezes (D9), and announces
   * the new state politely for SR users (S9).
   */
  function crisisFreeze(canvasId: string, frozen: boolean): void {
    setPendingCrisis(frozen ? "freeze" : "reopen");
    if (!frozen) setCrisisMode(null); // reopening closes any open ban/wipe surface
    if (frozen && !freezeHintSeen) {
      setFreezeHintSeen(true);
      try {
        localStorage.setItem(FREEZE_HINT_KEY, "1");
      } catch {
        /* private mode — the hint just shows again next session, harmless. */
      }
    }
    void freeze({ canvasId, frozen })
      .then(() =>
        setAnnounce(t(frozen ? "studio.crisis.announce.frozen" : "studio.crisis.announce.reopened")),
      )
      .catch(() => setAnnounce(t("common.error")))
      .finally(() => setPendingCrisis(null));
  }

  // Grouped triage tools (ban / wipe). Each opens its on-canvas selection surface
  // (FEN-160): the CrisisController renders the reticle/marquee, resolves the
  // target, confirms the blast radius, and dispatches `banAndWipe`/`deletePixels`.
  function promptBan(): void {
    setCrisisMode("ban");
  }
  function promptWipe(): void {
    setCrisisMode("wipe");
  }

  /**
   * Reactivate an archive. Because of the one-active invariant this silently
   * archives whatever is live now (a footgun mid-stream), so when there IS a
   * current active canvas we confirm the swap first (forgiveness — Norman), then
   * announce the result for sighted and SR users alike (S1 / S9 / FEN-143).
   */
  function reactivate(canvas: StreamerCanvas): void {
    if (
      activeTitle &&
      !window.confirm(t("studio.archives.reactivateConfirm", { active: activeTitle, next: canvas.title }))
    ) {
      return;
    }
    void activate({ canvasId: canvas.id });
    setAnnounce(t("studio.announce.activated", { title: canvas.title }));
  }

  return (
    <section className="lp-studio" aria-label={t("studio.title")}>
      <p className="ui-sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <header className="lp-studio__header">
        <h1 className="lp-studio__title">{t("studio.title")}</h1>
        {isSignedIn && (
          <Link to={paths.studioCreate()} className={buttonClass("primary", "md")}>
            + {t("studio.new")}
          </Link>
        )}
      </header>

      {(isPending || view.state === "loading") && (
        <p className="lp-studio__muted">{t("common.loading")}</p>
      )}

      {!isPending && view.state === "signedOut" && (
        <p className="lp-studio__muted">{t("studio.signInPrompt")}</p>
      )}

      {view.state === "ready" && view.isEmpty && (
        <EmptyState
          title={t("studio.empty.title")}
          action={
            <Link to={paths.studioCreate()} className={buttonClass("primary", "md")}>
              {t("studio.empty.cta")}
            </Link>
          }
        >
          <span className="lp-studio__muted">{t("studio.empty.body")}</span>
        </EmptyState>
      )}

      {view.state === "ready" && !view.isEmpty && (
        <>
          {view.active ? (
            <ActiveCard
              active={view.active}
              pendingCrisis={pendingCrisis}
              freezeHintSeen={freezeHintSeen}
              crisisMode={crisisMode}
              onToggleFreeze={(frozen) => crisisFreeze(view.active!.canvas.id, frozen)}
              onBan={promptBan}
              onWipe={promptWipe}
              onExitCrisis={() => setCrisisMode(null)}
            />
          ) : (
            // Has archives but nothing active — neutral copy + CTA, NOT the
            // greenfield "create your FIRST canvas" (S6 / FEN-143).
            <EmptyState
              title={t("studio.noActive.body")}
              action={
                <Link to={paths.studioCreate()} className={buttonClass("primary", "md")}>
                  {t("studio.new")}
                </Link>
              }
            />
          )}

          <h2 className="lp-studio__section-title">{t("studio.archives.title")}</h2>
          {view.archives.length === 0 ? (
            <p className="lp-studio__muted">{t("studio.archives.empty")}</p>
          ) : (
            <ul className="lp-studio__archive-list">
              {view.archives.map((row) => (
                <ArchiveRow
                  key={row.canvas.id}
                  row={row}
                  onReactivate={() => reactivate(row.canvas)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The single highlighted active canvas (WF-5 top block). */
export function ActiveCard({
  active,
  pendingCrisis,
  freezeHintSeen,
  crisisMode,
  onToggleFreeze,
  onBan,
  onWipe,
  onExitCrisis,
}: {
  active: ActiveCanvasView;
  pendingCrisis: CrisisActionId | null;
  freezeHintSeen: boolean;
  crisisMode: "ban" | "wipe" | null;
  /** `frozen` true → emergency-freeze; false → reopen. */
  onToggleFreeze: (frozen: boolean) => void;
  onBan: () => void;
  onWipe: () => void;
  onExitCrisis: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const { canvas, statusKey, visibilityKey } = active;
  return (
    // `ui-card` (raised DS surface) + `ui-stack` (token vertical rhythm).
    <article className="ui-card ui-stack" aria-label={canvas.title}>
      <div className="lp-studio__active-head">
        <span className="lp-studio__live">● {t("studio.active.label")}</span>
        <strong className="lp-studio__active-title">{canvas.title}</strong>
      </div>

      <p className="lp-studio__statusline">
        {/* Placement state — icon + label (never colour alone, AC4). */}
        <StatusPill state={canvas.placementOpen ? "open" : "frozen"} label={t(statusKey)} />
        <span>{t(visibilityKey)}</span>
        <span aria-hidden className="lp-studio__sep">
          ·
        </span>
        <span>{t("canvas.viewers", { count: canvas.viewerCount })}</span>
        <span aria-hidden className="lp-studio__sep">
          ·
        </span>
        <span>{t("studio.active.dimensions", { width: canvas.width, height: canvas.height })}</span>
      </p>

      <div className="lp-studio__actions">
        <Link to={paths.studioBroadcast(canvas.slug)} className={buttonClass("primary", "md")}>
          {t("studio.action.broadcast")}
        </Link>
        <Button variant="secondary" onClick={() => navigate(paths.canvas(canvas.slug))}>
          {t("studio.action.openCanvas")}
        </Button>
      </div>

      {/* Crisis surface (Lot I / FEN-121): emergency freeze in one gesture, then
          the grouped ban/wipe triage tools + reopen once frozen (WF-8 / Flow S3). */}
      <CrisisPanel
        placementOpen={canvas.placementOpen}
        pendingAction={pendingCrisis}
        freezeHintSeen={freezeHintSeen}
        onToggleFreeze={onToggleFreeze}
        onBan={onBan}
        onWipe={onWipe}
      />

      {/* Frozen-phase crisis triage: the on-canvas ban/wipe selection surfaces +
          the recent-actions undo list (FEN-160). Mounted only once frozen, when
          the grouped tools are reachable (Flow S3). */}
      {!canvas.placementOpen && (
        <CrisisController
          canvasId={canvas.id}
          slug={canvas.slug}
          bounds={{ width: canvas.width, height: canvas.height }}
          mode={crisisMode}
          onExit={onExitCrisis}
        />
      )}
    </article>
  );
}

/** One read-only archive row, with a reactivate action (one-active invariant). */
export function ArchiveRow({
  row,
  onReactivate,
}: {
  row: ArchiveRowView;
  onReactivate: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  const { canvas } = row;
  const date =
    canvas.archivedAt != null
      ? new Date(canvas.archivedAt).toLocaleDateString(locale)
      : null;
  return (
    <li className="lp-studio__archive-row">
      <Link to={paths.canvas(canvas.slug)} className="lp-studio__archive-link">
        <span className="lp-studio__archive-title">{canvas.title}</span>
        {date && (
          <span className="lp-studio__muted--sm">
            {t("studio.archives.archivedOn", { date })}
          </span>
        )}
      </Link>
      <Button variant="ghost" size="sm" onClick={onReactivate}>
        {t("studio.archives.reactivate")}
      </Button>
    </li>
  );
}
