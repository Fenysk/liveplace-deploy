/**
 * FEN-117 (UX Lot E) visual verification — renders the unified "puis-je poser ?"
 * indicator for EVERY state, in BOTH locales, to a self-contained HTML preview
 * WITHOUT a browser/gateway/Convex (none available here). It drives the REAL
 * {@link derivePlaceState} state machine over representative inputs and resolves
 * each result's label through the REAL FR/EN catalogs + {@link interpolate} — so
 * the page shows exactly the text a user would read at each state.
 *
 * The lot deliberately delegates colour/icon to the UI phase (ux-spec §D8/§D12),
 * so this artifact verifies the LOGIC + LABELS (yes/no + why + when, a text
 * label for every state, FR/EN parity), not the final visual design. The dashed
 * "blocked" / solid "ready" treatment here is a neutral placeholder, not a
 * design decision.
 *
 * Run: node --experimental-transform-types scripts/state-capture.ts
 * Out: apps/web/artifacts/place-states-preview.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivePlaceState, type PlaceStateInput } from "../src/features/canvas/placeState.ts";
// Catalogs imported from their (import-free) source files — see placeState.test.ts.
import { en } from "../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../packages/i18n/src/messages/fr.ts";
import { interpolate } from "../../../packages/i18n/src/format.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "artifacts");

const NOW = 1_700_000_000_000;
const fmt = () => "20:00"; // deterministic open-time label

function base(over: Partial<PlaceStateInput> = {}): PlaceStateInput {
  return {
    connection: "open",
    authenticated: true,
    permission: { allowed: true },
    eventStartAt: null,
    eventEndAt: null,
    gauge: { charges: 3, max: 6, cooldownUntil: 0 },
    now: NOW,
    formatTime: fmt,
    ...over,
  };
}

const emptyGauge = { charges: 0, max: 6, cooldownUntil: NOW + 9_000 };

/** One row per UX state (ux-spec §D8 matrix), with the input that triggers it. */
const SCENARIOS: Array<{ label: string; input: PlaceStateInput }> = [
  { label: "Ouvert / prêt", input: base() },
  { label: "Jauge vide / cooldown", input: base({ gauge: emptyGauge }) },
  { label: "Non connecté", input: base({ authenticated: false, gauge: null }) },
  { label: "Gelé (freeze)", input: base({ permission: { allowed: false, reason: "placement_closed" } }) },
  {
    label: "Pas commencé",
    input: base({ permission: { allowed: false, reason: "outside_event_window" }, eventStartAt: NOW + 3_600_000 }),
  },
  {
    label: "Terminé",
    input: base({ permission: { allowed: false, reason: "outside_event_window" }, eventStartAt: NOW - 7_200_000, eventEndAt: NOW - 3_600_000 }),
  },
  { label: "Archivé", input: base({ permission: { allowed: false, reason: "canvas_archived" } }) },
  { label: "Banni", input: base({ permission: { allowed: false, reason: "banned" } }) },
  { label: "Introuvable", input: base({ permission: { allowed: false, reason: "canvas_not_found" } }) },
  { label: "Chargement", input: base({ permission: undefined, gauge: null }) },
  { label: "Hors-ligne / reconnexion", input: base({ connection: "offline" }) },
];

function labelFor(catalog: Record<string, string>, key: string, params?: Record<string, string | number>): string {
  return interpolate(catalog[key] ?? `‹missing: ${key}›`, params);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const rows = SCENARIOS.map(({ label, input }) => {
  const s = derivePlaceState(input);
  const frLabel = labelFor(fr, s.messageKey, s.params);
  const enLabel = labelFor(en, s.messageKey, s.params);
  const cls = s.canPlace ? "ready" : s.blocking ? "hard" : "soft";
  const yn = s.canPlace ? "OUI" : "NON";
  return `      <tr class="${cls}">
        <td class="state">${esc(label)}<code>${esc(s.kind)}</code></td>
        <td class="yn">${yn}</td>
        <td class="lbl"><span class="loc">FR</span> ${esc(frLabel)}</td>
        <td class="lbl"><span class="loc">EN</span> ${esc(enLabel)}</td>
      </tr>`;
}).join("\n");

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LivePlace — états « puis-je poser ? » (FEN-117 / Lot E)</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 2rem; background: #14131a; color: #e9e7f0; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.5rem; color: #a39fb5; font-size: .9rem; max-width: 60ch; }
  table { border-collapse: collapse; width: 100%; max-width: 980px; }
  th, td { text-align: left; padding: .6rem .8rem; border-bottom: 1px solid #2a2836; vertical-align: top; }
  th { color: #a39fb5; font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  td.state { font-weight: 600; }
  td.state code { display: block; font-size: .72rem; color: #8b86a0; font-weight: 400; margin-top: .15rem; }
  td.yn { font-weight: 700; }
  td.lbl { font-size: .95rem; }
  td.lbl .loc { display: inline-block; min-width: 1.7rem; color: #8b86a0; font-size: .72rem; font-weight: 700; }
  tr.ready td.yn { color: #6ee7a8; }
  tr.ready { background: rgba(110,231,168,.06); }
  tr.soft td.yn { color: #f5c451; }
  tr.hard td.yn { color: #f08a8a; }
  /* Neutral placeholder marks — the real colour/icon is delegated to the UI phase. */
  tr.hard td.state { border-left: 3px solid #f08a8a; }
  tr.soft td.state { border-left: 3px dashed #f5c451; }
  tr.ready td.state { border-left: 3px solid #6ee7a8; }
  footer { margin-top: 1.5rem; color: #8b86a0; font-size: .8rem; max-width: 70ch; }
</style>
</head>
<body>
  <h1>États « puis-je poser ? » unifiés &amp; différenciés — FEN-117 (UX Lot E)</h1>
  <p class="sub">Un indicateur unique répond <strong>oui / non + pourquoi + quand</strong> pour chaque état,
  avant le clic. Libellé texte par état (C6 : jamais la couleur seule). Couleur/icône finales =
  phase UI (déléguées). Labels issus des catalogues FR/EN réels et de <code>derivePlaceState</code>.</p>
  <table>
    <thead>
      <tr><th>État</th><th>Poser ?</th><th>Libellé FR</th><th>Libellé EN</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <footer>Généré par <code>scripts/state-capture.ts</code> — verif visuelle des libellés/logique
  (la mise en forme visuelle relève de la phase UI, hors périmètre de ce lot).</footer>
</body>
</html>
`;

mkdirSync(OUT, { recursive: true });
const file = join(OUT, "place-states-preview.html");
writeFileSync(file, html, "utf8");
console.log(`Wrote ${file} (${SCENARIOS.length} states × FR/EN)`);
