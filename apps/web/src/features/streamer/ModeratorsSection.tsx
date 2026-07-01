/**
 * ModeratorsSection — owner-only panel listing Twitch moderators synced to
 * the active canvas, with a Resynchroniser button (FEN-1375).
 *
 * Data: moderation:listModerators (FEN-1374 extended return with
 * registeredOnLivePlace) + moderation:resyncModerators action.
 * Accessible: registration indicator uses text + color (not color alone).
 */
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { Button } from "../../ui/index.js";

// ─── Convex references ────────────────────────────────────────────────────────

interface ModRow {
  _id: string;
  twitchId: string;
  login?: string;
  displayName?: string;
  source: "twitch_sync" | "manual";
  active: boolean;
  syncedAt: number;
  userId?: string;
  registeredOnLivePlace: boolean;
}

interface ResyncResult {
  active: number;
  deactivated: number;
  syncedAt: number;
  error?: string;
}

const listModerators = makeFunctionReference<"query", { canvasId: string }, ModRow[]>(
  "moderation:listModerators",
);

const resyncModerators = makeFunctionReference<"action", { canvasId: string }, ResyncResult>(
  "moderation:resyncModerators",
);

// ─── Component ────────────────────────────────────────────────────────────────

export function ModeratorsSection({ canvasId }: { canvasId: string }): React.ReactElement {
  const t = useTranslate();
  const mods = useQuery(listModerators, { canvasId });
  const resync = useAction(resyncModerators);

  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [syncMsg, setSyncMsg] = useState("");

  function handleResync(): void {
    setSyncState("syncing");
    setSyncMsg("");
    void resync({ canvasId })
      .then((result) => {
        if (result.error) {
          setSyncState("error");
          setSyncMsg(t("studio.moderators.resyncError"));
        } else {
          setSyncState("ok");
          setSyncMsg(t("studio.moderators.resyncSuccess", { active: String(result.active) }));
        }
        setTimeout(() => setSyncState("idle"), 3000);
      })
      .catch(() => {
        setSyncState("error");
        setSyncMsg(t("studio.moderators.resyncError"));
        setTimeout(() => setSyncState("idle"), 3000);
      });
  }

  return (
    <section className="lp-studio__mods-section">
      <h2 className="lp-studio__section-title">{t("studio.moderators.section.title")}</h2>

      <div className="lp-studio__mods-actions">
        <Button
          variant="secondary"
          size="sm"
          loading={syncState === "syncing"}
          onClick={handleResync}
        >
          {syncState === "syncing"
            ? t("studio.moderators.resyncing")
            : t("studio.moderators.resync")}
        </Button>
        {syncState !== "idle" && syncMsg && (
          <p
            className={`lp-studio__mods-feedback lp-studio__mods-feedback--${syncState === "ok" ? "ok" : "err"}`}
            role={syncState === "error" ? "alert" : "status"}
          >
            {syncMsg}
          </p>
        )}
      </div>

      {mods === undefined && <p className="lp-studio__muted">{t("common.loading")}</p>}

      {mods !== undefined && mods.length === 0 && (
        <p className="lp-studio__muted">{t("studio.moderators.empty")}</p>
      )}

      {mods !== undefined && mods.length > 0 && (
        <ul className="lp-studio__mods-list" role="list">
          {mods.map((mod) => {
            const name = mod.displayName ?? mod.login ?? mod.twitchId;
            return (
              <li key={mod._id} className="lp-studio__mod-row">
                <span className="lp-studio__mod-name">{name}</span>
                <span
                  className={`lp-studio__mod-badge ${
                    mod.registeredOnLivePlace
                      ? "lp-studio__mod-badge--yes"
                      : "lp-studio__mod-badge--no"
                  }`}
                >
                  <span className="lp-studio__mod-dot" aria-hidden="true" />
                  {mod.registeredOnLivePlace
                    ? t("studio.moderators.registeredYes")
                    : t("studio.moderators.registeredNo")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
