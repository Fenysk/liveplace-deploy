/**
 * Studio states board (FEN-276) — the QA-capture surface for the three creator
 * screens whose POPULATED states are otherwise only reachable behind a Twitch
 * session + live Convex/gateway (so a static branch preview can't reach them).
 *
 * It feeds the SAME presentational components the real pages render
 * (`ActiveCard` / `ArchiveRow` from DashboardPage, `CreateCanvasForm`,
 * `ObsSourceBlock`) with mock data and no-op handlers — no Convex, no auth — so
 * pre-merge QA can verify Arcade fidelity + a11y on the dashboard card, the
 * create form and the OBS/diffuser block. Rendered after the foundation
 * StatesBoard on `/states` (see router.tsx). NOT a product route.
 */
import type { ReactElement, ReactNode } from "react";
import { EmptyState, buttonClass } from "../../ui/index.js";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { ActiveCard, ArchiveRow } from "./DashboardPage.js";
import { CreateCanvasForm } from "./CreateCanvasPage.js";
import { ObsSourceBlock } from "./ObsSourceBlock.js";
import { describeActive, type StreamerCanvas } from "./studioView.js";

/** Fixed timestamps (no Date.now in source) for the archive "archived on" copy. */
const ARCHIVED_AT_A = 1730419200000; // 2024-11-01
const ARCHIVED_AT_B = 1735689600000; // 2025-01-01

const MOCK_ACTIVE: StreamerCanvas = {
  id: "preview-active",
  slug: "ma-fresque",
  title: "Ma fresque du stream",
  status: "active",
  placementOpen: true,
  isPublic: true,
  width: 128,
  height: 128,
  viewerCount: 342,
  createdAt: 0,
  archivedAt: null,
};

const MOCK_ARCHIVES: StreamerCanvas[] = [
  {
    id: "preview-archive-1",
    slug: "halloween-2025",
    title: "Halloween 2025",
    status: "archived",
    placementOpen: false,
    isPublic: true,
    width: 64,
    height: 64,
    viewerCount: 0,
    createdAt: 0,
    archivedAt: ARCHIVED_AT_A,
  },
  {
    id: "preview-archive-2",
    slug: "noel-2025",
    title: "Noël 2025 (privé)",
    status: "archived",
    placementOpen: false,
    isPublic: false,
    width: 96,
    height: 96,
    viewerCount: 0,
    createdAt: 0,
    archivedAt: ARCHIVED_AT_B,
  },
];

function noop(): void {
  /* QA preview — handlers are inert. */
}

function Surface({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <h2 style={{ font: "var(--weight-bold) var(--text-lg)/1.2 var(--font-sans)", margin: 0 }}>
        {title}
      </h2>
      <div
        style={{
          border: "1px dashed var(--ui-border-strong)",
          borderRadius: "var(--da-radius-card)",
          padding: "var(--space-4)",
          background: "var(--ui-surface)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

export function StudioStatesBoard(): ReactElement {
  return (
    <main
      className="ui-surface"
      style={{
        padding: "var(--space-8)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8)",
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <h1 style={{ font: "var(--weight-bold) var(--text-xl)/1.2 var(--font-sans)", margin: 0 }}>
          Surfaces créateur — états peuplés (QA Lot C · FEN-276)
        </h1>
        <p style={{ color: "var(--ui-text-secondary)", margin: 0 }}>
          Données factices, sans Convex ni session — mêmes composants que les
          écrans réels. Bascule FR↔EN via le sélecteur de langue du site.
        </p>
      </header>

      {/* Dashboard — active card (open) + archives + empty state. */}
      <Surface title="Dashboard — carte active + archives">
        <section className="lp-studio" aria-label="Dashboard (aperçu)">
          <ActiveCard
            active={describeActive(MOCK_ACTIVE)}
            pendingCrisis={null}
            freezeHintSeen
            crisisMode={null}
            onToggleFreeze={noop}
            onBan={noop}
            onWipe={noop}
            onExitCrisis={noop}
          />
          <ul className="lp-studio__archive-list" style={{ marginTop: "var(--space-4)" }}>
            {MOCK_ARCHIVES.map((canvas) => (
              <ArchiveRow key={canvas.id} row={{ canvas }} onReactivate={noop} />
            ))}
          </ul>
        </section>
      </Surface>

      <Surface title="Dashboard — état vide (greenfield)">
        <EmptyState
          title="Aucune fresque"
          action={
            <Link to={paths.studioCreate()} className={buttonClass("primary", "md")}>
              Créer une fresque
            </Link>
          }
        >
          Lancez votre première fresque pour démarrer.
        </EmptyState>
      </Surface>

      {/* Create — default + the "name too long" error state. */}
      <Surface title="Création — formulaire (défaut)">
        <CreateCanvasForm customPalettes={[]} onCreate={async () => noop()} />
      </Surface>

      <Surface title="Création — nom trop long (erreur de champ annoncée)">
        <CreateCanvasForm
          customPalettes={[]}
          onCreate={async () => noop()}
          initialName={"x".repeat(90)}
        />
      </Surface>

      {/* OBS source block. */}
      <Surface title="Diffuser — lien OBS + copie">
        <ObsSourceBlock obsUrl="https://liveplace.tv/ma-fresque/obs" />
      </Surface>
    </main>
  );
}
