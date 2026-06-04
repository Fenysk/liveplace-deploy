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
 * go through `t(...)` for FR↔EN parity. Inline styles, like the rest of the shell
 * (the fine UI pass is delegated — Designer / Phase 3).
 */
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useLocale, useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client";
import { Link, navigate } from "../../router.js";
import { paths } from "../../routes.js";
import {
  buildDashboardView,
  type ArchiveRowView,
  type ActiveCanvasView,
  type StreamerCanvas,
} from "./studioView.js";
import { CrisisPanel } from "./CrisisPanel.js";
import type { CrisisActionId } from "./crisisView.js";

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

  // Grouped triage tools (ban / wipe). Both need a TARGET — which author, which
  // region — and that selection surface is the delegated visual piece for this
  // lot (UI phase / [FEN-153]). Here the buttons exist and are findable (the lot's
  // < 10 s acceptance); clicking announces the next step so the streamer knows to
  // pick the target on the canvas. The dispatch to `moderation.banAndWipe` /
  // `deletePixels` is wired when that selection lands.
  function promptBan(): void {
    setAnnounce(t("studio.crisis.banPrompt"));
  }
  function promptWipe(): void {
    setAnnounce(t("studio.crisis.wipePrompt"));
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
    <section style={pageStyle} aria-label={t("studio.title")}>
      <p style={srOnlyStyle} role="status" aria-live="polite">
        {announce}
      </p>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{t("studio.title")}</h1>
        {isSignedIn && (
          <Link to={paths.studioCreate()} style={primaryBtnStyle}>
            + {t("studio.new")}
          </Link>
        )}
      </header>

      {(isPending || view.state === "loading") && <p style={mutedStyle}>{t("common.loading")}</p>}

      {!isPending && view.state === "signedOut" && (
        <p style={mutedStyle}>{t("studio.signInPrompt")}</p>
      )}

      {view.state === "ready" && view.isEmpty && (
        <div style={emptyStyle}>
          <h2 style={{ margin: "0 0 0.5rem" }}>{t("studio.empty.title")}</h2>
          <p style={mutedStyle}>{t("studio.empty.body")}</p>
          <Link to={paths.studioCreate()} style={primaryBtnStyle}>
            {t("studio.empty.cta")}
          </Link>
        </div>
      )}

      {view.state === "ready" && !view.isEmpty && (
        <>
          {view.active ? (
            <ActiveCard
              active={view.active}
              pendingCrisis={pendingCrisis}
              freezeHintSeen={freezeHintSeen}
              onToggleFreeze={(frozen) => crisisFreeze(view.active!.canvas.id, frozen)}
              onBan={promptBan}
              onWipe={promptWipe}
            />
          ) : (
            // Has archives but nothing active — neutral copy + CTA, NOT the
            // greenfield "create your FIRST canvas" (S6 / FEN-143).
            <div style={emptyStyle}>
              <p style={mutedStyle}>{t("studio.noActive.body")}</p>
              <Link to={paths.studioCreate()} style={primaryBtnStyle}>
                {t("studio.new")}
              </Link>
            </div>
          )}

          <h2 style={sectionTitleStyle}>{t("studio.archives.title")}</h2>
          {view.archives.length === 0 ? (
            <p style={mutedStyle}>{t("studio.archives.empty")}</p>
          ) : (
            <ul style={archiveListStyle}>
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
function ActiveCard({
  active,
  pendingCrisis,
  freezeHintSeen,
  onToggleFreeze,
  onBan,
  onWipe,
}: {
  active: ActiveCanvasView;
  pendingCrisis: CrisisActionId | null;
  freezeHintSeen: boolean;
  /** `frozen` true → emergency-freeze; false → reopen. */
  onToggleFreeze: (frozen: boolean) => void;
  onBan: () => void;
  onWipe: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const { canvas, statusKey, visibilityKey } = active;
  return (
    <article style={activeCardStyle} aria-label={canvas.title}>
      <div style={activeHeadStyle}>
        <span style={liveBadgeStyle}>● {t("studio.active.label")}</span>
        <strong style={activeTitleStyle}>{canvas.title}</strong>
      </div>

      <p style={statusLineStyle}>
        <span>{t(statusKey)}</span>
        <span aria-hidden>·</span>
        <span>{t(visibilityKey)}</span>
        <span aria-hidden>·</span>
        <span>{t("canvas.viewers", { count: canvas.viewerCount })}</span>
        <span aria-hidden>·</span>
        <span>{t("studio.active.dimensions", { width: canvas.width, height: canvas.height })}</span>
      </p>

      <div style={actionRowStyle}>
        <Link to={paths.studioBroadcast(canvas.slug)} style={primaryBtnStyle}>
          {t("studio.action.broadcast")}
        </Link>
        <button
          type="button"
          style={secondaryBtnStyle}
          onClick={() => navigate(paths.canvas(canvas.slug))}
        >
          {t("studio.action.openCanvas")}
        </button>
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
    </article>
  );
}

/** One read-only archive row, with a reactivate action (one-active invariant). */
function ArchiveRow({
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
    <li style={archiveRowStyle}>
      <Link to={paths.canvas(canvas.slug)} style={archiveLinkStyle}>
        <span style={archiveTitleStyle}>{canvas.title}</span>
        {date && <span style={mutedSmallStyle}>{t("studio.archives.archivedOn", { date })}</span>}
      </Link>
      <button type="button" style={tertiaryBtnStyle} onClick={onReactivate}>
        {t("studio.archives.reactivate")}
      </button>
    </li>
  );
}

// --- Inline styles (delegated visual pass; usable defaults only) -------------
const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 760,
  margin: "2.5rem auto",
  padding: "0 1rem",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  marginBottom: "1.5rem",
};
const titleStyle: React.CSSProperties = { margin: 0 };
const sectionTitleStyle: React.CSSProperties = { margin: "2rem 0 0.75rem", fontSize: 18 };
const mutedStyle: React.CSSProperties = { color: "#777" };
const mutedSmallStyle: React.CSSProperties = { color: "#999", fontSize: 13 };
const emptyStyle: React.CSSProperties = {
  border: "1px dashed #cfcfd6",
  borderRadius: 12,
  padding: "2rem 1.5rem",
  textAlign: "center",
};
const activeCardStyle: React.CSSProperties = {
  border: "1px solid #d6d6de",
  borderRadius: 14,
  padding: "1.25rem 1.25rem 1rem",
  background: "#fff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};
const activeHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const liveBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 700,
  color: "#0a7d33",
  background: "#e4f7ea",
};
const activeTitleStyle: React.CSSProperties = { fontSize: 20 };
const statusLineStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "center",
  color: "#555",
  fontSize: 14,
  margin: "0.75rem 0 1rem",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};
// Shared ≥44×44px hit-area floor (WCAG 2.5.5 — S3 / FEN-143, same rule as the
// Lot G global-nav `navTapTargetStyle`). inline-flex + minHeight gives the
// <a>/<button> a full touch target independent of the delegated visual pass.
const tapFloor: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
};
const primaryBtnStyle: React.CSSProperties = {
  ...tapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #6441a5",
  background: "#6441a5",
  color: "#fff",
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
};
const secondaryBtnStyle: React.CSSProperties = {
  ...tapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #c7c7d1",
  background: "#fff",
  color: "#333",
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
};
const tertiaryBtnStyle: React.CSSProperties = {
  ...tapFloor,
  minWidth: 44,
  padding: "0.35rem 0.9rem",
  borderRadius: 7,
  border: "1px solid #d4d4dc",
  background: "#fafafb",
  color: "#444",
  fontSize: 13,
  cursor: "pointer",
};
/** Off-screen text exposed only to assistive tech (no global stylesheet here). */
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
const archiveListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const archiveRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.65rem 0.85rem",
  border: "1px solid #ececf1",
  borderRadius: 9,
  background: "#fcfcfd",
};
const archiveLinkStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  minHeight: 44,
  gap: 2,
  textDecoration: "none",
  color: "inherit",
  minWidth: 0,
};
const archiveTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
