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
 */
import { useEffect } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@canvas/convex/api";
import { authClient } from "../../auth/auth-client";
import { StudioDashboardBody } from "./StudioDashboardBody.js";
import "./studio.css";

// ─── Convex references (syncTwitchMods only) ─────────────────────────────────

interface SyncCanvasDoc {
  _id: string;
  status: "active" | "archived";
}

const listMyCanvases = api.canvases.listMyCanvases;
// S8.1 / FEN-779 — auto-sync the channel's Twitch moderators into the canvas
// roster (CA5). Helix GET /moderation/moderators only accepts the broadcaster's
// own token, so the owner's dashboard is the natural place to trigger it.
const syncTwitchMods = api.moderation.syncTwitchMods;

// ─── DashboardPage ────────────────────────────────────────────────────────────

export function DashboardPage(): React.ReactElement {
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

