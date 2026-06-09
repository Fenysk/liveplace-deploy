/**
 * Streamer crisis panel (UX Lot I — [FEN-121], spec §D6 Flow S3 / WF-8). The
 * presentational shell over the pure, unit-tested {@link buildCrisisPanel}
 * view-model: it renders the panel the model describes and forwards each action
 * to a callback. All structure/copy decisions live in the (headlessly tested)
 * view-model; this file only maps the descriptor to elements + `t(...)`, so the
 * lot's logic stays in its Definition-of-Done tests and the fine visual pass is
 * delegated to the UI phase (inline styles, like the rest of the streamer shell).
 *
 * Decoupling: this component is Convex-free — the host (DashboardPage) supplies
 * the handlers and wires them to `moderation.ts` (`setFrozen` for freeze/reopen;
 * `banAndWipe` / `deletePixels` for the grouped triage tools, whose author/region
 * SELECTION ui is the delegated visual piece). That keeps the crisis surface
 * reusable (dashboard today, broadcast overlay later) and testable in isolation.
 */
import { useTranslate } from "@canvas/i18n/react";
import { buildCrisisPanel, type CrisisActionId } from "./crisisView.js";

export interface CrisisPanelProps {
  /** Whether placement is currently open (active canvas `placementOpen`). */
  placementOpen: boolean;
  /** The action whose dispatch is in flight, if any (disables it — idempotency). */
  pendingAction?: CrisisActionId | null;
  /** Persisted "vu" flag for the one-time first-crisis freeze hint (D9). */
  freezeHintSeen?: boolean;
  /** Emergency freeze / reopen (the 1-gesture primary) → `moderation.setFrozen`. */
  onToggleFreeze: (frozen: boolean) => void;
  /** Open the (delegated) author-selection flow → `moderation.banAndWipe`. */
  onBan: () => void;
  /** Open the (delegated) region-selection flow → `moderation.deletePixels`. */
  onWipe: () => void;
}

/** Render the crisis panel from the pure descriptor; forward actions to the host. */
export function CrisisPanel(props: CrisisPanelProps): React.ReactElement {
  const t = useTranslate();
  const view = buildCrisisPanel({
    placementOpen: props.placementOpen,
    pendingAction: props.pendingAction ?? null,
    freezeHintSeen: props.freezeHintSeen,
  });

  function dispatch(id: CrisisActionId): void {
    switch (id) {
      case "freeze":
        props.onToggleFreeze(true);
        break;
      case "reopen":
        props.onToggleFreeze(false);
        break;
      case "ban":
        props.onBan();
        break;
      case "wipe":
        props.onWipe();
        break;
      case "restore":
        break; // restore is paired with a wipe's audit row — host-routed, not a bare button
    }
  }

  return (
    <section
      className="lp-crisis"
      data-phase={view.phase}
      aria-label={t(view.statusKey)}
      style={panelStyle}
    >
      <p className="lp-crisis-status" role="status">
        {t(view.statusKey)}
      </p>

      {/* The always-present 1-gesture panic control. Emphasised so it is found in
          < 10 s under stress (the lot's acceptance); colour/size → UI phase. */}
      <button
        type="button"
        className="lp-btn is-primary lp-crisis-primary"
        data-action={view.primary.id}
        disabled={view.primary.pending}
        onClick={() => dispatch(view.primary.id)}
        style={primaryStyle}
      >
        {t(view.primary.labelKey)}
      </button>

      {/* First-crisis onboarding: signal once where the freeze lives (D9). It is
          self-dismissing — the host persists `freezeHintSeen` the first time the
          streamer actually freezes, so it is never shown again ("vu mémorisé"). */}
      {view.firstCrisisHintKey && (
        <p className="lp-crisis-hint" role="note">
          {t(view.firstCrisisHintKey)}
        </p>
      )}

      {/* Grouped triage tools — present only once frozen (Flow S3). */}
      {view.group.length > 0 && (
        <div className="lp-crisis-group" role="group" aria-label={t(view.statusKey)} style={groupStyle}>
          {view.group.map((a) => (
            <button
              key={a.id}
              type="button"
              className="lp-btn lp-crisis-tool"
              data-action={a.id}
              data-destructive={a.destructive ? "true" : undefined}
              disabled={a.pending}
              onClick={() => dispatch(a.id)}
            >
              {t(a.labelKey)}
            </button>
          ))}
        </div>
      )}

      {/* §2.5 forewarning by the wipe tool: erasing re-reveals what was underneath. */}
      {view.wipeWarningKey && (
        <p className="lp-crisis-warning" role="note">
          {t(view.wipeWarningKey)}
        </p>
      )}
    </section>
  );
}

// Minimal structural styles only — the fine visual pass is delegated (UI phase).
const panelStyle: React.CSSProperties = { display: "grid", gap: "0.5rem" };
const primaryStyle: React.CSSProperties = { fontWeight: 700 };
const groupStyle: React.CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
