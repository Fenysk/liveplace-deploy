import { useState, type ReactElement, type ReactNode } from "react";
import {
  Button,
  Card,
  Celebration,
  ColorSelector,
  EmptyState,
  Field,
  Gauge,
  Row,
  Skeleton,
  Stack,
  StatusPill,
  Toast,
  TwitchGlyph,
  Wordmark,
  type PaletteColor,
  type PillState,
} from "./index.js";

/**
 * StatesBoard (handoff §2/§4 — "Planche d'états") — the living reference for the
 * Arcade component library: every component in every state/variant, rendered
 * with the real tokens. This is the QA capture surface (FEN-193, desktop 1440 +
 * mobile 390) and the visual proof that the foundation matches the preview.
 *
 * It is a COMPOSITION of the shared components — zero local re-implementation.
 */

const PALETTE: PaletteColor[] = [
  { id: "white", hex: "#ffffff", label: "Blanc" },
  { id: "black", hex: "#18181c", label: "Noir" },
  { id: "red", hex: "#d6381f", label: "Rouge" },
  { id: "amber", hex: "#f4a020", label: "Ambre" },
  { id: "green", hex: "#198547", label: "Vert" },
  { id: "blue", hex: "#2563c9", label: "Bleu" },
  { id: "purple", hex: "#9146ff", label: "Violet" },
  { id: "gray", hex: "#90909a", label: "Gris" },
];

const PILLS: Array<{ state: PillState; label: string }> = [
  { state: "open", label: "Ouvert" },
  { state: "cooldown", label: "Recharge" },
  { state: "frozen", label: "Gelé" },
  { state: "ended", label: "Terminé" },
  { state: "error", label: "Erreur" },
];

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <h2 style={{ font: "var(--weight-bold) var(--text-lg)/1.2 var(--font-sans)", margin: 0 }}>
        {title}
      </h2>
      <Card>
        <Row style={{ flexWrap: "wrap", gap: "var(--space-4)", alignItems: "flex-start" }}>
          {children}
        </Row>
      </Card>
    </section>
  );
}

export function StatesBoard(): ReactElement {
  const [color, setColor] = useState<string>("red");
  const [celebrate, setCelebrate] = useState(false);

  return (
    <main
      className="ui-surface"
      style={{
        minHeight: "100vh",
        padding: "var(--space-8)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8)",
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <Wordmark size="lg" />
        <p style={{ color: "var(--ui-text-secondary)", margin: 0 }}>
          Planche d'états · direction Arcade (FEN-268, Lot 0)
        </p>
      </header>

      <Section title="Button — variants × sizes × états">
        <Stack>
          <Row style={{ flexWrap: "wrap" }}>
            <Button variant="primary" size="sm">Primaire sm</Button>
            <Button variant="primary" size="md">Primaire md</Button>
            <Button variant="primary" size="lg">Primaire lg</Button>
          </Row>
          <Row style={{ flexWrap: "wrap" }}>
            <Button variant="secondary">Secondaire</Button>
            <Button variant="ghost">Fantôme</Button>
            <Button variant="primary" loading>Chargement</Button>
            <Button variant="primary" disabled>Désactivé</Button>
            <Button variant="primary" icon={<TwitchGlyph size={18} />}>
              Connexion Twitch
            </Button>
          </Row>
        </Stack>
      </Section>

      <Section title="Field — default · focus · error · disabled">
        <Stack style={{ minWidth: 280 }}>
          <Field label="Pseudo" placeholder="ex. pixelpro" hint="Visible publiquement" />
          <Field label="URL OBS" prefix="https://" placeholder="liveplace.tv/obs/…" />
          <Field label="Nom de fresque" defaultValue="Trop court" error="3 caractères minimum." />
          <Field label="Identifiant" defaultValue="verrouillé" disabled />
        </Stack>
      </Section>

      <Section title="StatusPill — 5 états (icône + label)">
        {PILLS.map((p) => (
          <StatusPill key={p.state} state={p.state} label={p.label} />
        ))}
      </Section>

      <Section title="Gauge — ready (réserve) · cooldown (anneau + tnum)">
        <Gauge mode="ready" ready={3} max={6} nextLabel="3/6 pixels" />
        <Gauge mode="cooldown" seconds={5} percent={60} nextLabel="Prochain pixel" />
      </Section>

      <Section title="Gauge — rampe cooldown (FEN-169/171 : waiting · armed · ready)">
        <Gauge mode="cooldown" seconds={5} percent={30} phase="waiting" nextLabel="Recharge…" />
        <Gauge mode="cooldown" seconds={2} percent={70} phase="armed" nextLabel="Case visée" />
        <Gauge mode="cooldown" seconds={0} percent={100} phase="ready" nextLabel="Prêt — confirme" />
      </Section>

      <Section title="Toast — success · info · error">
        <Stack>
          <Toast kind="success" title="Pixel posé !">Réserve −1.</Toast>
          <Toast kind="info" title="Fresque gelée">Reprise dans 2 min.</Toast>
          <Toast kind="error" title="Pose refusée">Cellule déjà prise.</Toast>
        </Stack>
      </Section>

      <Section title="ColorSelector — palette (fidélité couleur)">
        <ColorSelector colors={PALETTE} value={color} onChange={setColor} ariaLabel="Couleur de pose" />
      </Section>

      <Section title="Surfaces — vide · chargement">
        <Stack style={{ minWidth: 240 }}>
          <Skeleton style={{ height: 48 }} />
          <Skeleton style={{ height: 48, width: "70%" }} />
        </Stack>
        <EmptyState
          title="Aucune fresque"
          action={<Button variant="primary" size="md">Créer une fresque</Button>}
        >
          Lancez votre première fresque pour démarrer.
        </EmptyState>
      </Section>

      <Section title="Célébration — moment Kano (confetti + pixel-pop + titre Press Start)">
        <Button variant="primary" size="md" onClick={() => setCelebrate(true)}>
          Déclencher la célébration
        </Button>
      </Section>

      {/* Non-blocking overlay: pointer-events none, self-dismisses in 2.6s. */}
      <Celebration
        show={celebrate}
        title="Premier pixel !"
        message="Tu es sur la toile. Continue !"
        pop="+1"
        autoDismissMs={2600}
        onDismiss={() => setCelebrate(false)}
      />
    </main>
  );
}
