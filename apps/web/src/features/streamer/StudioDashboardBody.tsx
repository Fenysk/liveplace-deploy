/**
 * StudioDashboardBody — reusable studio content (FEN-1177 / S5, refonte FEN-1356).
 *
 * Two sections: Résumé (name + Switch visibility + OBS URL) and Paramètres
 * (horizontal size radios + canvas list). A single conditional « Sauvegarder »
 * button appears only when the user has unsaved changes. The crisis block sits
 * at the bottom without decorative pills.
 *
 * Self-contained: owns Convex subscriptions (listMyCanvases, activateCanvas,
 * moderation:setFrozen) and all derived UI state. Rendered by two hosts:
 *   (a) DashboardPage (/studio route) — page-level section wrapper.
 *   (b) StudioPanel (in-canvas bottom-sheet / drawer) — panel shell.
 *
 * a11y: form labels via htmlFor/id; aria-describedby + aria-invalid on name;
 * role="status" aria-live="polite" for mutations; role="alert" on save errors;
 * role="switch" + aria-checked for visibility toggle; focus-visible via CSS.
 */
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { Id } from "@canvas/convex/dataModel";
import { api } from "@canvas/convex/api";
import { useLocale, useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client.js";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, Switch, buttonClass } from "../../ui/index.js";
import {
  buildDashboardView,
  buildObsUrl,
  validateCanvasName,
  SIZE_PRESETS,
  sizePreset,
  MAX_CANVAS_NAME,
  type ArchiveRowView,
  type StreamerCanvas,
  type SizeKey,
} from "./studioView.js";
import { ObsSourceBlock } from "./ObsSourceBlock.js";
import { CrisisPanel } from "./CrisisPanel.js";
import { CrisisController } from "./CrisisController.js";
import { ModeratorsSection } from "./ModeratorsSection.js";
import { StudioSubScreenButtons } from "./StudioSubScreenButtons.js";
import type { CrisisActionId } from "./crisisView.js";
import "./studio.css";

// ─── Convex function references ──────────────────────────────────────────────

interface CanvasDoc {
  _id: Id<"canvases">;
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

const listMyCanvases = api.canvases.listMyCanvases;
const activateCanvas = api.canvases.activateCanvas;
const setFrozen = api.moderation.setFrozen;
const updateCanvasConfig = api.canvases.updateCanvasConfig;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FREEZE_HINT_KEY = "lp.crisis.freezeHintSeen";
function readFreezeHintSeen(): boolean {
  try {
    return localStorage.getItem(FREEZE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

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

// ─── ShrinkConfirmDialog ─────────────────────────────────────────────────────

/** Modal shown when a resize would delete out-of-frame pixels (FEN-1798 C-D). */
function ShrinkConfirmDialog({
  onConfirm,
  onCancel,
  pending,
  outOfBoundsCount,
  width,
  height,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
  outOfBoundsCount: number;
  width: number;
  height: number;
}): React.ReactElement {
  const t = useTranslate();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !pending) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const msg = t("studio.config.resizeConfirm", { count: outOfBoundsCount, width, height });

  return (
    <div style={shrinkBackdropStyle}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={msg}
        style={shrinkCardStyle}
      >
        <p style={shrinkTitleStyle}>{msg}</p>
        <div style={shrinkActionsStyle}>
          <button type="button" style={shrinkCancelStyle} onClick={onCancel}>
            {t("studio.crisis.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            style={shrinkConfirmStyle}
            disabled={pending}
            onClick={onConfirm}
          >
            {t("studio.config.resize.confirmButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

const shrinkTapFloor: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
};
const shrinkBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "grid",
  placeItems: "center",
  zIndex: 50,
  padding: "1rem",
};
const shrinkCardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 14,
  padding: "1.25rem",
  maxWidth: 420,
  width: "100%",
  display: "grid",
  gap: "0.6rem",
  boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
};
const shrinkTitleStyle: React.CSSProperties = { margin: 0, fontWeight: 700, fontSize: 16 };
const shrinkActionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  justifyContent: "flex-end",
  marginTop: "0.4rem",
  flexWrap: "wrap",
};
const shrinkCancelStyle: React.CSSProperties = {
  ...shrinkTapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #c7c7d1",
  background: "#fff",
  color: "#333",
  fontWeight: 600,
  cursor: "pointer",
};
const shrinkConfirmStyle: React.CSSProperties = {
  ...shrinkTapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #b3261e",
  background: "#b3261e",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};

// ─── CanvasConfigSection ─────────────────────────────────────────────────────

/**
 * Full config form for the active canvas — two sections (Résumé + Paramètres)
 * plus a conditional global save button. Wires `canvases:updateCanvasConfig`
 * with a single call on submit. A shrink that would delete out-of-frame pixels
 * returns `{requiresConfirmation, outOfBoundsCount}`; the form shows a blocking
 * modal and re-calls with `confirmDeleteOutOfBounds: true` on explicit accept
 * (FEN-1798 C-D).
 */
function CanvasConfigSection({
  canvas,
  archives,
  onReactivate,
  onClose,
  showCreateButton,
}: {
  canvas: StreamerCanvas;
  archives: ArchiveRowView[];
  onReactivate: (c: StreamerCanvas) => void;
  onClose?: () => void;
  showCreateButton?: boolean;
}): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  const navigate = useNavigate();
  const updateConfig = useMutation(updateCanvasConfig);

  const matchedPreset = SIZE_PRESETS.find(
    (p) => p.dimension === canvas.width && p.dimension === canvas.height,
  );

  const [name, setName] = useState(canvas.title);
  const [sizeKey, setSizeKey] = useState<SizeKey | null>(matchedPreset?.key ?? null);
  const [isPublic, setIsPublic] = useState(canvas.isPublic);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [shrinkPendingArgs, setShrinkPendingArgs] = useState<{
    canvasId: Id<"canvases">;
    title?: string;
    width?: number;
    height?: number;
    isPublic?: boolean;
    outOfBoundsCount: number;
  } | null>(null);

  const validation = validateCanvasName(name);

  const isDirty =
    name.trim() !== canvas.title ||
    isPublic !== canvas.isPublic ||
    (sizeKey !== null && sizeKey !== (matchedPreset?.key ?? null));

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!validation.ok || saveState === "saving") return;
    setSaveState("saving");

    const args: {
      canvasId: Id<"canvases">;
      title?: string;
      width?: number;
      height?: number;
      isPublic?: boolean;
    } = { canvasId: canvas.id as Id<"canvases"> };

    if (validation.trimmed) args.title = validation.trimmed;
    if (isPublic !== canvas.isPublic) args.isPublic = isPublic;

    if (sizeKey !== null) {
      const preset = sizePreset(sizeKey);
      if (preset.dimension !== canvas.width || preset.dimension !== canvas.height) {
        args.width = preset.dimension;
        args.height = preset.dimension;
      }
    }

    try {
      const result = await updateConfig(args);
      if (result?.requiresConfirmation) {
        setShrinkPendingArgs({ ...args, outOfBoundsCount: result.outOfBoundsCount });
        setSaveState("idle");
      } else {
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      }
    } catch {
      setSaveState("error");
    }
  }

  async function handleShrinkConfirm(): Promise<void> {
    if (!shrinkPendingArgs || saveState === "saving") return;
    setSaveState("saving");
    const { outOfBoundsCount: _count, ...baseArgs } = shrinkPendingArgs;
    try {
      await updateConfig({ ...baseArgs, confirmDeleteOutOfBounds: true });
      setShrinkPendingArgs(null);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setShrinkPendingArgs(null);
      setSaveState("error");
    }
  }

  function handleShrinkCancel(): void {
    setShrinkPendingArgs(null);
    setSizeKey(matchedPreset?.key ?? null);
  }

  return (
    <form
      className="lp-studio__config-form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      {/* ── Section Canvas actif ── */}
      <section className="lp-studio__section">
        <h2 className="lp-studio__section-title">{t("studio.config.section.activeCanvas")}</h2>

        {/* Name field */}
        <div className="lp-studio__config-field">
          <label className="lp-studio__config-label" htmlFor="canvas-config-name">
            {t("studio.config.nameLabel")}
          </label>
          <input
            id="canvas-config-name"
            type="text"
            className="lp-studio__config-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_CANVAS_NAME}
            aria-describedby={!validation.ok ? "canvas-config-name-error" : undefined}
            aria-invalid={!validation.ok || undefined}
          />
          {!validation.ok && validation.reasonKey && (
            <p id="canvas-config-name-error" className="lp-studio__config-error" role="alert">
              {t(validation.reasonKey)}
            </p>
          )}
        </div>

        {/* Visibility Switch */}
        <div className="lp-studio__config-field">
          <span className="lp-studio__config-label" id="vis-group-label">
            {t("studio.config.visibility.label")}
          </span>
          <div
            className="lp-studio__vis-row"
            role="group"
            aria-labelledby="vis-group-label"
          >
            <span className={isPublic ? "lp-studio__vis-state" : "lp-studio__vis-state--active"}>
              {t("studio.config.visibility.private")}
            </span>
            <Switch
              checked={isPublic}
              onChange={setIsPublic}
              label={
                isPublic
                  ? t("studio.config.visibility.public")
                  : t("studio.config.visibility.private")
              }
            />
            <span className={isPublic ? "lp-studio__vis-state--active" : "lp-studio__vis-state"}>
              {t("studio.config.visibility.public")}
            </span>
          </div>
        </div>

        {/* Size radios */}
        <div className="lp-studio__config-field">
          <fieldset className="lp-studio__fieldset">
            <legend className="lp-studio__config-label">{t("studio.config.sizeLabel")}</legend>
            <div className="lp-studio__size-grid">
              {SIZE_PRESETS.map((preset) => (
                <label key={preset.key} className="lp-studio__size-option">
                  <input
                    type="radio"
                    name="canvas-config-size"
                    value={preset.key}
                    checked={sizeKey === preset.key}
                    onChange={() => setSizeKey(preset.key)}
                  />
                  <span className="lp-studio__size-key">{t(preset.labelKey)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {/* OBS URL block */}
        <div className="lp-studio__config-field">
          <ObsSourceBlock obsUrl={buildObsUrl(window.location.origin, canvas.slug)} />
        </div>
      </section>

      {/* ── Save button — visible quand dirty ou feedback en cours ── */}
      {(isDirty || saveState === "saved" || saveState === "error") && (
        <div className="lp-studio__save-row">
          {isDirty && (
            <Button
              type="submit"
              variant="primary"
              disabled={!validation.ok || saveState === "saving"}
              loading={saveState === "saving"}
            >
              {saveState === "saving" ? t("studio.config.saving") : t("studio.config.save")}
            </Button>
          )}
          {saveState === "saved" && (
            <p
              className="lp-studio__config-feedback lp-studio__config-feedback--ok"
              role="status"
            >
              {t("studio.config.saved")}
            </p>
          )}
          {saveState === "error" && (
            <p
              className="lp-studio__config-feedback lp-studio__config-feedback--err"
              role="alert"
            >
              {t("studio.config.error")}
            </p>
          )}
        </div>
      )}

      {/* ── Section Mes canvas ── */}
      <section className="lp-studio__section">
        <h2 className="lp-studio__section-title">{t("studio.config.canvases.title")}</h2>

        {/* + Nouveau canvas en tête de liste */}
        {showCreateButton && (
          <Link to="/studio/new" className={buttonClass("primary", "md")}>
            + {t("studio.new")}
          </Link>
        )}

        <div className="lp-studio__canvas-list">
          <div className="lp-studio__canvas-row lp-studio__canvas-row--active">
            <div className="lp-studio__canvas-info">
              <span className="lp-studio__canvas-name">{canvas.title}</span>
              <span className="lp-studio__canvas-badge">{t("studio.active.label")}</span>
            </div>
          </div>
          {archives.map((row) => {
            const date =
              row.canvas.archivedAt != null
                ? new Date(row.canvas.archivedAt).toLocaleDateString(locale)
                : null;
            return (
              <div key={row.canvas.id} className="lp-studio__canvas-row">
                <div className="lp-studio__canvas-info">
                  <Link
                    to="/$pseudo"
                    params={{ pseudo: row.canvas.slug }}
                    className="lp-studio__canvas-name"
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    {row.canvas.title}
                  </Link>
                  {date && (
                    <span className="lp-studio__muted--sm">
                      {t("studio.archives.archivedOn", { date })}
                    </span>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => onReactivate(row.canvas)}>
                  {t("studio.config.canvases.activate")}
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Navigation ── */}
      {onClose ? (
        <StudioSubScreenButtons onClose={onClose} />
      ) : (
        <div className="lp-studio__actions">
          <Button variant="secondary" onClick={() => void navigate({ to: "/$pseudo", params: { pseudo: canvas.slug } })}>
            {t("studio.action.openCanvas")}
          </Button>
        </div>
      )}

      {/* ── Shrink confirmation modal ── */}
      {shrinkPendingArgs !== null && (
        <ShrinkConfirmDialog
          pending={saveState === "saving"}
          outOfBoundsCount={shrinkPendingArgs.outOfBoundsCount}
          width={shrinkPendingArgs.width ?? canvas.width}
          height={shrinkPendingArgs.height ?? canvas.height}
          onConfirm={() => {
            void handleShrinkConfirm();
          }}
          onCancel={handleShrinkCancel}
        />
      )}
    </form>
  );
}

// ─── StudioDashboardBody ─────────────────────────────────────────────────────

export interface StudioDashboardBodyProps {
  headingId?: string;
  onClose?: () => void;
}

export function StudioDashboardBody({
  headingId,
  onClose,
}: StudioDashboardBodyProps = {}): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  const { data: session, isPending } = authClient.useSession();
  const isSignedIn = !!session;

  const docs = useQuery(listMyCanvases, isSignedIn ? {} : "skip");
  const activate = useMutation(activateCanvas);
  const freeze = useAction(setFrozen);

  const [announce, setAnnounce] = useState("");
  const [pendingCrisis, setPendingCrisis] = useState<CrisisActionId | null>(null);
  const [freezeHintSeen, setFreezeHintSeen] = useState(readFreezeHintSeen);
  const [crisisMode, setCrisisMode] = useState<"ban" | "wipe" | null>(null);

  const view = buildDashboardView(docs?.map(toStreamerCanvas), {
    isSignedIn: isSignedIn && !isPending,
  });
  const activeTitle = view.state === "ready" ? view.active?.canvas.title ?? null : null;

  function crisisFreeze(canvasId: string, frozen: boolean): void {
    setPendingCrisis(frozen ? "freeze" : "reopen");
    if (!frozen) setCrisisMode(null);
    if (frozen && !freezeHintSeen) {
      setFreezeHintSeen(true);
      try {
        localStorage.setItem(FREEZE_HINT_KEY, "1");
      } catch {
        /* private mode */
      }
    }
    void freeze({ canvasId: canvasId as Id<"canvases">, frozen })
      .then(() =>
        setAnnounce(
          t(frozen ? "studio.crisis.announce.frozen" : "studio.crisis.announce.reopened"),
        ),
      )
      .catch(() => setAnnounce(t("common.error")))
      .finally(() => setPendingCrisis(null));
  }

  function reactivate(canvas: StreamerCanvas): void {
    if (
      activeTitle &&
      !window.confirm(
        t("studio.archives.reactivateConfirm", { active: activeTitle, next: canvas.title }),
      )
    ) {
      return;
    }
    void activate({ canvasId: canvas.id as Id<"canvases"> });
    setAnnounce(t("studio.announce.activated", { title: canvas.title }));
  }

  return (
    <>
      {/* Polite SR region for freeze/reopen/activate announcements */}
      <p className="ui-sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <header className="lp-studio__header">
        <h1 id={headingId} className="lp-studio__title">
          {t("studio.title")}
        </h1>
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
            onClose ? (
              <StudioSubScreenButtons onClose={onClose} />
            ) : (
              <Link to="/studio/new" className={buttonClass("primary", "md")}>
                {t("studio.empty.cta")}
              </Link>
            )
          }
        >
          <span className="lp-studio__muted">{t("studio.empty.body")}</span>
        </EmptyState>
      )}

      {view.state === "ready" && !view.isEmpty && (
        <>
          {view.active ? (
            <CanvasConfigSection
              canvas={view.active.canvas}
              archives={view.archives}
              onReactivate={reactivate}
              onClose={onClose}
              showCreateButton={isSignedIn && !onClose}
            />
          ) : (
            <>
              <EmptyState
                title={t("studio.noActive.body")}
                action={
                  onClose ? (
                    <StudioSubScreenButtons onClose={onClose} />
                  ) : (
                    <Link to="/studio/new" className={buttonClass("primary", "md")}>
                      {t("studio.new")}
                    </Link>
                  )
                }
              />
              {/* Canvas list (archives only) when no active canvas */}
              {view.archives.length > 0 && (
                <div className="lp-studio__canvas-list" style={{ marginTop: "var(--space-4)" }}>
                  {view.archives.map((row) => {
                    const date =
                      row.canvas.archivedAt != null
                        ? new Date(row.canvas.archivedAt).toLocaleDateString(locale)
                        : null;
                    return (
                      <div key={row.canvas.id} className="lp-studio__canvas-row">
                        <div className="lp-studio__canvas-info">
                          <Link
                            to="/$pseudo"
                            params={{ pseudo: row.canvas.slug }}
                            className="lp-studio__canvas-name"
                            style={{ textDecoration: "none", color: "inherit" }}
                          >
                            {row.canvas.title}
                          </Link>
                          {date && (
                            <span className="lp-studio__muted--sm">
                              {t("studio.archives.archivedOn", { date })}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => reactivate(row.canvas)}
                        >
                          {t("studio.config.canvases.activate")}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Moderators block — owner-only, above crisis (FEN-1375) */}
          {view.active && (
            <ModeratorsSection canvasId={view.active.canvas.id as Id<"canvases">} />
          )}

          {/* Crisis block — at the bottom, no decorative pills */}
          {view.active && (
            <section className="lp-studio__crisis-section">
              <h2 className="lp-studio__section-title">{t("studio.crisis.section.title")}</h2>
              <CrisisPanel
                placementOpen={view.active.canvas.placementOpen}
                pendingAction={pendingCrisis}
                freezeHintSeen={freezeHintSeen}
                onToggleFreeze={(frozen) => crisisFreeze(view.active!.canvas.id, frozen)}
                onBan={() => setCrisisMode("ban")}
                onWipe={() => setCrisisMode("wipe")}
              />
              {!view.active.canvas.placementOpen && (
                <CrisisController
                  canvasId={view.active.canvas.id as Id<"canvases">}
                  slug={view.active.canvas.slug}
                  bounds={{
                    width: view.active.canvas.width,
                    height: view.active.canvas.height,
                  }}
                  mode={crisisMode}
                  onExit={() => setCrisisMode(null)}
                />
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}

