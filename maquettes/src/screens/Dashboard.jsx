import { useState } from "react";
import Button from "../components/ui/Button.jsx";
import Field from "../components/ui/Field.jsx";
import Wordmark from "../components/Wordmark.jsx";
import StatusPill from "../components/StatusPill.jsx";
import { PALETTE } from "../data/fresco.js";

/**
 * Dashboard streamer / création-config — signature screen (cadrage §8.1.3).
 * Job (Maxime, le streamer): create & configure a fresco for his stream and
 * get the OBS link in <2 min. Left = live control panel, right = config form.
 * Arcade direction throughout (coral primary, squared signature corners).
 */
function Stat({ k, v, sub }) {
  return (
    <div className="rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-3">
      <div className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--ui-text-tertiary)]">{k}</div>
      <div className="mt-1 text-[var(--text-2xl)] font-bold tnum leading-none">{v}</div>
      {sub && <div className="mt-1 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">{sub}</div>}
    </div>
  );
}

function SizeOption({ label, dims, active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="flex-1 rounded-[var(--da-radius-control)] border px-3 py-2.5 text-left transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "var(--ui-border-strong)",
        background: active ? "var(--accent-soft)" : "var(--ui-surface-raised)",
        boxShadow: active ? "inset 0 0 0 1px var(--accent)" : "none",
      }}
    >
      <div className="text-[var(--text-sm)] font-semibold">{label}</div>
      <div className="text-[var(--text-xs)] text-[var(--ui-text-secondary)] tnum">{dims}</div>
    </button>
  );
}

export default function Dashboard({ viewport = "desktop" }) {
  const [size, setSize] = useState("m");
  const compact = viewport === "mobile";

  const form = (
    <div className="flex flex-col gap-4">
      <Field label="Nom de la fresque" value="La fresque du stream" />
      <div>
        <span className="mb-1.5 block text-[var(--text-sm)] font-semibold">Taille</span>
        <div className="flex gap-2">
          <SizeOption label="Petite" dims="32×20" active={size === "s"} onClick={() => setSize("s")} />
          <SizeOption label="Moyenne" dims="64×40" active={size === "m"} onClick={() => setSize("m")} />
          <SizeOption label="Grande" dims="128×80" active={size === "l"} onClick={() => setSize("l")} />
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[var(--text-sm)] font-semibold">Palette</span>
          <span className="text-[var(--text-xs)] text-[var(--ui-text-secondary)]">16 couleurs</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE.map((c) => (
            <span key={c.id} className="h-6 w-6 rounded-[var(--radius-sm)]" title={c.name}
              style={{ background: c.hex, boxShadow: "inset 0 0 0 1px rgba(24,24,28,.18)" }} />
          ))}
        </div>
      </div>
      <Field label="Recharge (secondes / pixel)" value="30" type="number" hint="Plus court = fresque plus rapide, plus chaotique." />
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col bg-[var(--ui-bg)]">
      <header className="flex items-center justify-between border-b border-[var(--ui-border)] bg-[var(--ui-surface)] px-5 py-3">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="hidden text-[var(--text-sm)] text-[var(--ui-text-secondary)] sm:inline">/ Studio créateur</span>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill state="open" label="Fresque en live" />
          <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-pill)] text-[var(--text-sm)] font-bold text-white" style={{ background: "var(--accent)" }}>M</div>
        </div>
      </header>

      <div className={`flex min-h-0 flex-1 ${compact ? "flex-col overflow-auto" : ""}`}>
        {/* live control panel */}
        <section className={`${compact ? "" : "w-[60%] border-r border-[var(--ui-border)]"} flex flex-col gap-4 p-5`}>
          <div className="grid grid-cols-3 gap-3">
            <Stat k="Spectateurs" v="1 248" sub="+312 / 10 min" />
            <Stat k="Pixels posés" v="8 530" sub="142 / min" />
            <Stat k="Participants" v="396" sub="connectés Twitch" />
          </div>
          <div className="rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-sm)] font-semibold">Lien OBS (navigateur source)</span>
              <Button size="sm" variant="secondary">Copier</Button>
            </div>
            <code className="mt-2 block truncate rounded-[var(--radius-sm)] bg-[var(--ui-bg)] px-3 py-2 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">
              https://liveplace.tv/obs/la-fresque-du-stream?key=•••••
            </code>
            <p className="mt-2 text-[var(--text-xs)] text-[var(--ui-text-tertiary)]">
              Fond transparent, contour visible sur n'importe quel stream.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary">Mettre en pause</Button>
            <Button variant="ghost">Réinitialiser la fresque</Button>
          </div>
        </section>

        {/* config form */}
        <aside className={`${compact ? "" : "flex-1"} bg-[var(--ui-surface)] p-5`}>
          <h2 className="mb-4 text-[var(--text-lg)] font-bold">Configuration</h2>
          {form}
          <Button size="lg" className="mt-5 w-full">Enregistrer les changements</Button>
        </aside>
      </div>
    </div>
  );
}
