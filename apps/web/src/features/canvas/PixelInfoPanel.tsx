/**
 * Pixel-info dialog panel (FEN-249 / FEN-755) + inline 2-tap moderation actions
 * (FEN-754 §8.2). Extracted from CanvasView.tsx (l.2009-2158).
 *
 * Rendered inside the HUD BottomSheet when `pixelInfo !== null`.
 * Read-only — clicking never stages a cell; "Dessiner" starts selection.
 */
import { useState } from "react";
import type { TranslateFn } from "@canvas/i18n";
import { Button, TwitchGlyph } from "../../ui/index.js";
import { PALETTE_HEX } from "./renderer.js";
import type { PixelInfoVM } from "./pixelInfo.js";
import type { ModAction } from "./usePixelInspect.js";

const MOD_EXPANDED_KEY = "lp:pixelinfo:mod:expanded";

function readModExpanded(): boolean {
  try { return sessionStorage.getItem(MOD_EXPANDED_KEY) === "1"; } catch { return false; }
}

function saveModExpanded(v: boolean): void {
  try {
    if (v) sessionStorage.setItem(MOD_EXPANDED_KEY, "1");
    else sessionStorage.removeItem(MOD_EXPANDED_KEY);
  } catch { /* ignore */ }
}

export interface PixelInfoPanelProps {
  pixelInfo: PixelInfoVM;
  pixelInfoAuthorText: string;
  pixelInfoDateText: string | null;
  modArmed: ModAction | null;
  setModArmed: (a: ModAction | null) => void;
  modPending: boolean;
  canModerate: boolean;
  convexAuthed: boolean;
  authPending: boolean;
  drawFromInspect: () => void;
  runModAction: (action: ModAction) => Promise<void>;
  onSignIn: () => void;
  /** Open the profile sheet for a pixel's author (FEN-1967). */
  openProfile: (login: string) => void;
  t: TranslateFn;
}

export function PixelInfoPanel({
  pixelInfo,
  pixelInfoAuthorText,
  pixelInfoDateText,
  modArmed,
  setModArmed,
  modPending,
  canModerate,
  convexAuthed,
  authPending,
  drawFromInspect,
  runModAction,
  onSignIn,
  openProfile,
  t,
}: PixelInfoPanelProps): React.ReactElement {
  const [modExpanded, setModExpanded] = useState<boolean>(readModExpanded);

  function toggleMod(): void {
    const next = !modExpanded;
    setModExpanded(next);
    saveModExpanded(next);
  }

  return (
    <div
      className="lp-pixelinfo"
      role="dialog"
      aria-label={t("canvas.pixelInfo.title")}
      data-author-state={pixelInfo.authorState}
    >
      {/* Header row: colour swatch + coordinates */}
      <div className="lp-pixelinfo-header">
        {pixelInfo.color > 0 && (
          <span
            className="lp-pixelinfo-swatch"
            style={{ background: PALETTE_HEX[pixelInfo.color] ?? "#ffffff" }}
            aria-hidden="true"
          />
        )}
        <p className="lp-pixelinfo-coords">
          {t("canvas.pixelInfo.coords", { x: pixelInfo.x, y: pixelInfo.y })}
        </p>
      </div>
      {/* Author row: avatar (known only) + login or anon label */}
      <div className="lp-pixelinfo-author">
        {pixelInfo.authorState === "known" && pixelInfo.avatarUrl && (
          <img
            src={pixelInfo.avatarUrl}
            alt=""
            aria-hidden="true"
            className="lp-pixelinfo-avatar"
            width={24}
            height={24}
          />
        )}
        <p className="lp-pixelinfo-author-text">
          {/* « Posé anonymement » is a self-contained phrase, so the "Posé par"
              prefix would read as the broken "Posé par Posé anonymement" — drop
              the label in the anonymous case (FEN-332). */}
          {pixelInfo.authorState !== "unknown" && (
            <>
              <span className="lp-pixelinfo-author-label">{t("canvas.pixelInfo.authorLabel")}</span>{" "}
            </>
          )}
          {pixelInfo.authorState === "known" && pixelInfo.authorLogin ? (
            <button
              type="button"
              className="lp-pixelinfo-author-value lp-pixelinfo-author-btn"
              onClick={() => openProfile(pixelInfo.authorLogin!)}
            >
              {pixelInfoAuthorText}
            </button>
          ) : (
            <span className="lp-pixelinfo-author-value">{pixelInfoAuthorText}</span>
          )}
        </p>
      </div>
      {/* Placement date/time — shown for any occupied cell (known or anon) */}
      {pixelInfoDateText && (
        <p className="lp-pixelinfo-date">{pixelInfoDateText}</p>
      )}
      {/* AC-B6: hide Dessiner + Fermer while a mod action awaits confirmation. */}
      {modArmed === null && (
        <div className="lp-pixelinfo-actions">
          {convexAuthed ? (
            <Button variant="primary" className="lp-pixelinfo-draw" onClick={drawFromInspect}>
              {t("canvas.draw")}
            </Button>
          ) : !authPending ? (
            // B1: direct OAuth (no modal) — no batch staged yet at this point.
            <Button
              className="lp-pixelinfo-draw lp-auth__twitch"
              icon={<TwitchGlyph size={20} />}
              onClick={onSignIn}
            >
              {t("auth.signIn")}
            </Button>
          ) : null}
        </div>
      )}

      {/* Pixel-click moderation (FEN-754 §8.2 / FEN-1962 / FEN-1984) — progressive
          disclosure: collapsed by default, expanded on demand, state persisted in
          sessionStorage. Two actions: delete group + ban (order: least → most
          destructive). Two-tap confirm flow unchanged (AC-B6). */}
      {canModerate && !pixelInfo.isEmpty && (
        <div className="lp-pixelinfo-mod" role="group" aria-label={t("canvas.mod.title")}>
          <button
            type="button"
            className="lp-pixelinfo-mod-toggle"
            aria-expanded={modExpanded}
            onClick={toggleMod}
          >
            <span className="lp-pixelinfo-mod-toggle-label">{t("canvas.mod.title")}</span>
            <span className="lp-pixelinfo-mod-toggle-chevron" aria-hidden="true">
              {modExpanded ? "▾" : "▸"}
            </span>
          </button>
          {modExpanded && (
            <div className="lp-pixelinfo-mod-body">
              {modArmed === null ? (
                <div className="lp-pixelinfo-mod-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setModArmed("deleteGroup")}
                  >
                    {t("canvas.mod.deleteGroup")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="lp-pixelinfo-mod-danger"
                    onClick={() => setModArmed("ban")}
                  >
                    {t("canvas.mod.ban")}
                  </Button>
                </div>
              ) : (
                <div className="lp-pixelinfo-mod-confirm" role="alertdialog" aria-label={t("canvas.mod.title")}>
                  <p className="lp-pixelinfo-mod-prompt">
                    {modArmed === "deleteGroup"
                      ? t("canvas.mod.confirmDeleteGroup")
                      : pixelInfo.authorLogin
                        ? t("canvas.mod.confirmBan", { login: pixelInfo.authorLogin })
                        : t("canvas.mod.confirmBanAnon")}
                  </p>
                  <div className="lp-pixelinfo-mod-confirm-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={modPending}
                      onClick={() => void runModAction(modArmed)}
                    >
                      {modPending ? t("canvas.mod.working") : t("canvas.mod.confirm")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={modPending}
                      onClick={() => setModArmed(null)}
                    >
                      {t("canvas.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
