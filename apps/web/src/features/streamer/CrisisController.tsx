/**
 * Crisis ban/wipe/restore host ([FEN-160], spec FEN-157 §2/§3/§4). The Convex
 * wiring + state machine for the three selection surfaces — kept OUT of the pure
 * `crisisSelection.ts` (logic, unit-tested) and the presentational
 * `CrisisSelector`/`CrisisConfirmDialog`/`CrisisHistory` (Convex-free). This is
 * the "host wires Convex" seam, the same decoupled `makeFunctionReference`
 * convention as DashboardPage / CanvasViewLive.
 *
 * Flows:
 *   - Ban: pick a pixel → `authorAt` resolves the author (empty/protected guards,
 *     the owner/mod soft-guard via `listModerators` + the session id) →
 *     `banBlastRadius` previews the count → confirm → `banAndWipe`.
 *   - Wipe: outline a region (client geometry) → confirm (count + §2.5 + large
 *     warning) → `deletePixels`.
 *   - Restore: the "Actions récentes" list (`listAuditLog`, reversible removals)
 *     → overwrite-forewarning confirm → `restore` (idempotent → row "Restauré").
 *
 * One aria-live pair (polite + assertive) announces a single beat at a time so
 * the live regions never pile up (acceptance §6.6, same discipline as FEN-140/124).
 */
import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { authClient } from "../../auth/auth-client";
import { useTranslate } from "@canvas/i18n/react";
import { CrisisSelector } from "./CrisisSelector.js";
import { CrisisConfirmDialog } from "./CrisisConfirmDialog.js";
import { CrisisHistory } from "./CrisisHistory.js";
import {
  banConfirmView,
  resolveBanPick,
  wipeConfirmView,
  resultAnnounce,
  classifyResult,
  cancelledAnnounce,
  restoreConfirmView,
  restoreResultAnnounce,
  type BanTarget,
  type CellCoord,
  type CrisisAnnounce,
  type AuditRow,
} from "./crisisSelection.js";

// --- Convex function references (decoupled from generated codegen) -----------
const authorAtRef = makeFunctionReference<
  "query",
  { canvasId: string; x: number; y: number },
  { userId: string; displayName?: string } | null
>("moderation:authorAt");
const banBlastRadiusRef = makeFunctionReference<
  "query",
  { canvasId: string; targetUserId: string },
  { pixels: number }
>("moderation:banBlastRadius");
const listModeratorsRef = makeFunctionReference<
  "query",
  { canvasId: string },
  Array<{ userId?: string }>
>("moderation:listModerators");
const listAuditLogRef = makeFunctionReference<"query", { canvasId: string; limit?: number }, AuditRow[]>(
  "moderation:listAuditLog",
);
type ModResult = { cellsAffected: number; dispatched: boolean; detail: string };
const banAndWipeRef = makeFunctionReference<
  "action",
  { canvasId: string; targetUserId: string },
  ModResult
>("moderation:banAndWipe");
const deletePixelsRef = makeFunctionReference<
  "action",
  { canvasId: string; cells: CellCoord[] },
  ModResult
>("moderation:deletePixels");
const restoreRef = makeFunctionReference<"action", { canvasId: string; modActionId: string }, ModResult>(
  "moderation:restore",
);

export interface CrisisControllerProps {
  canvasId: string;
  slug: string;
  /** Canvas geometry (the large-wipe 25%-of-area warning input). */
  bounds: { width: number; height: number };
  /** Active selection flow, or null when no surface is open (driven by CrisisPanel). */
  mode: "ban" | "wipe" | null;
  /** Exit select-mode (clear `mode`) — wired by the host to the CrisisPanel. */
  onExit: () => void;
}

export function CrisisController(props: CrisisControllerProps): React.ReactElement {
  const t = useTranslate();
  const { data: session } = authClient.useSession();
  const sessionUserId = session?.user?.id ?? null;
  const anonLabel = t("studio.crisis.ban.anonAuthor");

  // One beat at a time, split by politeness so errors are assertive (§6.6).
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  function announce(a: CrisisAnnounce): void {
    const text = t(a.key, a.params);
    if (a.role === "alert") {
      setAssertive(text);
      setPolite("");
    } else {
      setPolite(text);
      setAssertive("");
    }
  }

  // Ban: picked cell → resolved author → confirm target.
  const [banPick, setBanPick] = useState<CellCoord | null>(null);
  const [banTarget, setBanTarget] = useState<BanTarget | null>(null);
  // Wipe: outlined region awaiting confirm.
  const [wipeRegion, setWipeRegion] = useState<{ cells: CellCoord[]; count: number } | null>(null);
  // Restore: the audit row awaiting the overwrite-forewarning confirm.
  const [restoreRow, setRestoreRow] = useState<{ id: string; cells: number } | null>(null);
  const [restoredIds, setRestoredIds] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [restorePendingId, setRestorePendingId] = useState<string | null>(null);

  const banAndWipe = useAction(banAndWipeRef);
  const deletePixels = useAction(deletePixelsRef);
  const restore = useAction(restoreRef);

  const moderators = useQuery(listModeratorsRef, { canvasId: props.canvasId }) ?? undefined;
  const auditRows = useQuery(listAuditLogRef, { canvasId: props.canvasId });
  const author = useQuery(
    authorAtRef,
    banPick ? { canvasId: props.canvasId, x: banPick.x, y: banPick.y } : "skip",
  );
  const blast = useQuery(
    banBlastRadiusRef,
    banTarget ? { canvasId: props.canvasId, targetUserId: banTarget.userId } : "skip",
  );

  // Resolve a ban pick once `authorAt` returns (undefined === still loading).
  useEffect(() => {
    if (!banPick || banTarget || author === undefined) return;
    const isProtected =
      !!author &&
      (author.userId === sessionUserId ||
        (moderators ?? []).some((m) => m.userId && m.userId === author.userId));
    const outcome = resolveBanPick(author, isProtected);
    if (outcome.kind === "confirm") {
      setBanTarget(outcome.target);
    } else {
      announce(outcome.announce); // empty / protected — stay in select-mode
      setBanPick(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [author, banPick, banTarget, moderators, sessionUserId]);

  function resetBan(): void {
    setBanTarget(null);
    setBanPick(null);
  }

  // A dispatch failure must NOT dump the mod out of select-mode (spec FEN-157 §2
  // Flow A unhappy-path): under a raid, a transient error otherwise forces a full
  // re-aim at the griefer's pixel. So we exit only on a clean/pending outcome; on
  // error (or a thrown action, treated as error) we re-enable the action and KEEP
  // select-mode + the confirm target so retry is one gesture. Escape/Annuler still
  // exit via cancelMode regardless (FEN-176).
  function confirmBan(): void {
    if (!banTarget) return;
    setPending(true);
    void banAndWipe({ canvasId: props.canvasId, targetUserId: banTarget.userId })
      .then((res) => {
        announce(resultAnnounce("ban", res));
        return classifyResult(res);
      })
      .catch(() => {
        announce(resultAnnounce("ban", { cellsAffected: 0, dispatched: false, detail: "error" }));
        return "error" as const;
      })
      .then((outcome) => {
        setPending(false); // re-enable the action either way
        if (outcome === "clean" || outcome === "pending") {
          resetBan();
          props.onExit();
        }
        // error/noop → stay in select-mode with banTarget kept so retry needs no re-aim.
      });
  }

  function confirmWipe(): void {
    if (!wipeRegion) return;
    setPending(true);
    void deletePixels({ canvasId: props.canvasId, cells: wipeRegion.cells })
      .then((res) => {
        announce(resultAnnounce("wipe", res));
        return classifyResult(res);
      })
      .catch(() => {
        announce(resultAnnounce("wipe", { cellsAffected: 0, dispatched: false, detail: "error" }));
        return "error" as const;
      })
      .then((outcome) => {
        setPending(false); // re-enable the action either way
        if (outcome === "clean" || outcome === "pending") {
          setWipeRegion(null);
          props.onExit();
        }
        // error/noop → keep the outlined region so retry needs no re-outline.
      });
  }

  function confirmRestore(): void {
    if (!restoreRow) return;
    const id = restoreRow.id;
    setRestorePendingId(id);
    void restore({ canvasId: props.canvasId, modActionId: id })
      .then((res) => {
        announce(restoreResultAnnounce(res));
        setRestoredIds((prev) => new Set(prev).add(id)); // idempotent → row reads "Restauré"
      })
      .catch(() =>
        announce(restoreResultAnnounce({ cellsAffected: 0, dispatched: false, detail: "error" })),
      )
      .finally(() => {
        setRestorePendingId(null);
        setRestoreRow(null);
      });
  }

  function cancelMode(): void {
    announce(cancelledAnnounce());
    resetBan();
    setWipeRegion(null);
    props.onExit();
  }

  const banConfirm = banTarget ? banConfirmView(banTarget, blast?.pixels ?? null, anonLabel) : null;
  const wipeConfirm = wipeRegion ? wipeConfirmView(wipeRegion.count, props.bounds) : null;

  return (
    <div className="lp-crisis-controller">
      {/* Single-beat live regions (split by politeness; never pile up). */}
      <p role="status" aria-live="polite" style={srOnly}>
        {polite}
      </p>
      <p role="alert" aria-live="assertive" style={srOnly}>
        {assertive}
      </p>

      {/* The on-canvas pick surface, while a flow is active. */}
      {props.mode && (
        <CrisisSelector
          slug={props.slug}
          mode={props.mode}
          onBanPick={(cell) => setBanPick(cell)}
          onWipeRegion={(cells, count) => setWipeRegion({ cells, count })}
          onCancel={cancelMode}
          onAnnounce={announce}
        />
      )}

      {/* Ban blast-radius confirm (§2.4). */}
      {banConfirm && (
        <CrisisConfirmDialog
          title={banConfirm.title}
          lines={[banConfirm.count]}
          confirmLabelKey="studio.crisis.ban"
          pending={pending}
          onConfirm={confirmBan}
          onCancel={cancelMode}
        />
      )}

      {/* Wipe count + §2.5 + large-area confirm (§3.3). */}
      {wipeConfirm && (
        <CrisisConfirmDialog
          title={wipeConfirm.confirm}
          lines={[wipeConfirm.largeWarning, wipeConfirm.canConfirm ? null : wipeConfirm.emptyHint]}
          confirmLabelKey="studio.crisis.wipe"
          pending={pending || !wipeConfirm.canConfirm}
          onConfirm={confirmWipe}
          onCancel={cancelMode}
        />
      )}

      {/* Restore overwrite-forewarning confirm (§4). */}
      {restoreRow && (
        <CrisisConfirmDialog
          title={restoreConfirmView(restoreRow.cells)}
          confirmLabelKey="studio.crisis.restore"
          pending={restorePendingId === restoreRow.id}
          onConfirm={confirmRestore}
          onCancel={() => setRestoreRow(null)}
        />
      )}

      {/* The recent-actions / undo list (§4 Flow C). */}
      <CrisisHistory
        rows={auditRows}
        restoredIds={restoredIds}
        pendingId={restorePendingId}
        onRestore={(id) => {
          const row = (auditRows ?? []).find((r) => r._id === id);
          if (row) setRestoreRow({ id, cells: row.cellsAffected });
        }}
      />
    </div>
  );
}

/** Off-screen text exposed only to assistive tech (no global stylesheet here). */
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
