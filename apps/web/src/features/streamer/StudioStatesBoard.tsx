/**
 * Studio states board (FEN-276) — the QA-capture surface for creator screens
 * whose states are otherwise only reachable behind a Twitch session + live
 * Convex/gateway. Rendered after the foundation StatesBoard on `/states` (see
 * router.tsx). NOT a product route.
 */
import type { ReactElement, ReactNode } from "react";
import { EmptyState, buttonClass } from "../../ui/index.js";
import { Link } from "@tanstack/react-router";
import { CreateCanvasForm } from "./CreateCanvasPage.js";
import { ObsSourceBlock } from "./ObsSourceBlock.js";

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

      <Surface title="Dashboard — état vide (greenfield)">
        <EmptyState
          title="Aucune fresque"
          action={
            <Link to="/studio/new" className={buttonClass("primary", "md")}>
              Créer une fresque
            </Link>
          }
        >
          Lancez votre première fresque pour démarrer.
        </EmptyState>
      </Surface>

      {/* Create — default + the "name too long" error state. */}
      <Surface title="Création — formulaire (défaut)">
        <CreateCanvasForm onCreate={async () => noop()} />
      </Surface>

      <Surface title="Création — nom trop long (erreur de champ annoncée)">
        <CreateCanvasForm
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
