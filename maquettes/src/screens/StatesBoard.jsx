import Button from "../components/ui/Button.jsx";
import Field from "../components/ui/Field.jsx";
import Toast from "../components/ui/Toast.jsx";
import Gauge from "../components/Gauge.jsx";
import StatusPill from "../components/StatusPill.jsx";

/**
 * Planche d'états exhaustive (cadrage handoff). NOT a product screen — the
 * reference sheet Dev Frontend builds against: every component in every state,
 * plus the surface-level vide / chargement / erreur. Rendered in the retained
 * Arcade direction so the states are the real ones devs will ship.
 */
function Cell({ title, children, wide = false }) {
  return (
    <div className={`rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-4 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="mb-3 text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--ui-text-tertiary)]">{title}</div>
      {children}
    </div>
  );
}

function SurfaceEmpty() {
  return (
    <div className="grid place-items-center rounded-[var(--radius-md)] border border-dashed border-[var(--ui-border-strong)] p-6 text-center">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ui-text-tertiary)" strokeWidth="1.8" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M21 16l-5-5-9 9" />
      </svg>
      <div className="mt-1 text-[var(--text-sm)] font-semibold">Aucune fresque pour l'instant</div>
      <div className="mt-0.5 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">Lance ta première fresque pour démarrer.</div>
      <Button size="sm" className="mt-3">Créer une fresque</Button>
    </div>
  );
}
function SurfaceLoading() {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--ui-border)] p-4">
      {[80, 100, 64].map((w, i) => (
        <div key={i} className="lp-cooldown-pulse mb-2 h-3 rounded-[var(--radius-sm)]"
          style={{ width: `${w}%`, background: "color-mix(in srgb,var(--ui-text) 10%,transparent)" }} />
      ))}
      <div className="mt-1 text-[var(--text-xs)] text-[var(--ui-text-tertiary)]">Chargement de la fresque…</div>
    </div>
  );
}
function SurfaceError() {
  return (
    <div className="grid place-items-center rounded-[var(--radius-md)] border p-6 text-center"
      style={{ borderColor: "var(--status-error-fg)", background: "var(--status-error-bg)" }}>
      <div aria-hidden className="text-[24px]" style={{ color: "var(--status-error-fg)" }}>!</div>
      <div className="mt-1 text-[var(--text-sm)] font-semibold">Connexion perdue</div>
      <div className="mt-0.5 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">La fresque n'a pas pu se charger.</div>
      <Button size="sm" variant="secondary" className="mt-3">Réessayer</Button>
    </div>
  );
}

function ModalMock() {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-md)]" style={{ minHeight: 168 }}>
      <div className="absolute inset-0" style={{ background: "color-mix(in srgb,var(--ui-text) 45%,transparent)" }} />
      <div className="absolute inset-0 grid place-items-center p-3">
        <div className="w-full max-w-[300px] rounded-[var(--da-radius-card)] bg-[var(--ui-surface-raised)] p-4 shadow-[var(--elev-3)]">
          <div className="text-[var(--text-base)] font-bold">Réinitialiser la fresque ?</div>
          <p className="mt-1 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">Tous les pixels seront effacés. Action irréversible.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost">Annuler</Button>
            <Button size="sm" style={{ background: "var(--status-error-fg)" }}>Tout effacer</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StatesBoard() {
  return (
    <div className="w-full bg-[var(--ui-bg)] p-5">
      <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-4 sm:grid-cols-3">
        {/* FIELDS — full matrix */}
        <Cell title="Champs — default / focus / erreur / désactivé" wide>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Default" placeholder="Nom de la fresque" />
            <Field label="Focus" value="La fresque du stream" state="focus" />
            <Field label="Erreur" value="x" error="Le nom doit faire au moins 3 caractères." />
            <Field label="Désactivé" value="Verrouillé en live" disabled />
          </div>
        </Cell>

        {/* BUTTONS — variants × states */}
        <Cell title="Boutons — variantes / états" wide>
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button loading>Chargement</Button>
            <Button disabled>Désactivé</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
          </div>
        </Cell>

        <Cell title="Sélecteur / jauge / pills">
          <div className="flex flex-col gap-3">
            <Gauge mode="ready" ready={3} max={4} />
            <Gauge mode="cooldown" seconds={9} />
            <div className="flex flex-wrap gap-1.5">
              <StatusPill state="open" /><StatusPill state="cooldown" />
              <StatusPill state="frozen" /><StatusPill state="ended" /><StatusPill state="error" />
            </div>
          </div>
        </Cell>

        {/* TOASTS */}
        <Cell title="Toasts">
          <div className="flex flex-col gap-2">
            <Toast kind="success" title="Pixel posé !">Recharge dans 30 s.</Toast>
            <Toast kind="info" title="Fresque mise en pause">Le streamer a suspendu la pose.</Toast>
            <Toast kind="error" title="Échec de la pose">Réessaie dans un instant.</Toast>
          </div>
        </Cell>

        {/* MODAL */}
        <Cell title="Modale (destructive)"><ModalMock /></Cell>

        {/* SURFACE STATES */}
        <Cell title="Surface — vide"><SurfaceEmpty /></Cell>
        <Cell title="Surface — chargement"><SurfaceLoading /></Cell>
        <Cell title="Surface — erreur"><SurfaceError /></Cell>
      </div>
    </div>
  );
}
