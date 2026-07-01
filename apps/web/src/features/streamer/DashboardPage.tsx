/**
 * Streamer dashboard — /studio route (FEN-120 / Lot H, WF-5, flow S1 entry).
 *
 * Rewired onto StudioDashboardBody (FEN-1393): DashboardPage is now a thin
 * page-level wrapper. All data/UI logic lives in StudioDashboardBody.
 *
 * Retained in this file:
 *   — syncTwitchMods side-effect (S8.1 / FEN-779): best-effort auto-sync of
 *     the channel's Twitch moderators onto the active canvas. Fire-and-forget;
 *     missing scope or unlinked account must never break the dashboard.
 *   — ActiveCard / ArchiveRow exports: consumed by StudioStatesBoard (/states
 *     QA surface, FEN-276) with mock data and no-op handlers.
 */
import { useEffect } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useLocale, useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client";
import { Link, navigate } from "../../router.js";
import { paths } from "../../routes.js";
import { Button, StatusPill } from "../../ui/index.js";
import {
  buildObsUrl,
  type ArchiveRowView,
  type ActiveCanvasView,
} from "./studioView.js";
import { ObsSourceBlock } from "./ObsSourceBlock.js";
import { CrisisPanel } from "./CrisisPanel.js";
import { CrisisController } from "./CrisisController.js";
import type { CrisisActionId } from "./crisisView.js";
import { StudioDashboardBody } from "./StudioDashboardBody.js";
import "./studio.css";

// ─── Convex references (syncTwitchMods only) ─────────────────────────────────

interface SyncCanvasDoc {
  _id: string;
  status: "active" | "archived";
}

const listMyCanvases = makeFunctionReference<"query", Record<string, never>, SyncCanvasDoc[]>(
  "canvases:listMyCanvases",
);
// S8.1 / FEN-779 — auto-sync the channel's Twitch moderators into the canvas
// roster (CA5). Helix GET /moderation/moderators only accepts the broadcaster's
// own token, so the owner's dashboard is the natural place to trigger it.
const syncTwitchMods = makeFunctionReference<
  "action",
  { canvasId: string },
  { active: number; deactivated: number }
>("moderation:syncTwitchMods");

// ─── DashboardPage ────────────────────────────────────────────────────────────

export function DashboardPage(): React.ReactElement {
  const t = useTranslate();
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session;

  // Lightweight query solely for the syncMods effect — same ref as
  // StudioDashboardBody, so Convex deduplicates the subscription.
  const docs = useQuery(listMyCanvases, isSignedIn ? {} : "skip");
  const syncMods = useAction(syncTwitchMods);
  const activeCanvasId = docs?.find((d) => d.status === "active")?._id ?? null;

  useEffect(() => {
    if (!activeCanvasId) return;
    void syncMods({ canvasId: activeCanvasId }).catch(() => {
      /* opportunistic — ignore scope/auth errors */
    });
  }, [activeCanvasId, syncMods]);

  return (
    <section className="lp-studio" aria-labelledby="studio-page-heading">
      <StudioDashboardBody headingId="studio-page-heading" />
    </section>
  );
}

// ─── ActiveCard / ArchiveRow — retained for StudioStatesBoard (/states) ──────

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
    <article className="ui-card ui-stack" aria-label={canvas.title}>
      <div className="lp-studio__active-head">
        <span className="lp-studio__live">● {t("studio.active.label")}</span>
        <strong className="lp-studio__active-title">{canvas.title}</strong>
      </div>

      <p className="lp-studio__statusline">
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
        <ObsSourceBlock obsUrl={buildObsUrl(window.location.origin, canvas.slug)} />
        <Button variant="secondary" onClick={() => navigate(paths.canvas(canvas.slug))}>
          {t("studio.action.openCanvas")}
        </Button>
      </div>

      <CrisisPanel
        placementOpen={canvas.placementOpen}
        pendingAction={pendingCrisis}
        freezeHintSeen={freezeHintSeen}
        onToggleFreeze={onToggleFreeze}
        onBan={onBan}
        onWipe={onWipe}
      />

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
