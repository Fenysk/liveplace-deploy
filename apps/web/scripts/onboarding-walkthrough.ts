/**
 * Visual-verify artifact for FEN-118 (Lot C onboarding). No browser in this env,
 * so we drive the REAL {@link OnboardingCoach} through the viewer funnel and
 * render each resolved hint — in BOTH locales (parité FR/EN) — into a single
 * self-contained HTML page styled like the in-app banner. It also exercises the
 * connaisseur short-circuit and the persistence ("vu" par étape) so the artifact
 * is proof of behaviour, not a mock-up.
 *
 *   node --experimental-transform-types scripts/onboarding-walkthrough.ts
 *   → apps/web/artifacts/onboarding-walkthrough.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import the worktree i18n source directly (the node_modules @canvas/i18n
// symlink resolves to a sibling clone; this artifact must read THIS tree's keys).
import { en } from "../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../packages/i18n/src/messages/fr.ts";
import { interpolate, type MessageParams } from "../../../packages/i18n/src/format.ts";
import {
  OnboardingCoach,
  type OnboardingEvent,
  type OnboardingHint,
  type OnboardingStorage,
  type PersistedOnboarding,
} from "../src/features/canvas/onboarding.ts";

function memoryStorage(): OnboardingStorage {
  let state: PersistedOnboarding | null = null;
  return {
    load: () => state,
    save: (s) => {
      state = s;
    },
  };
}

interface Frame {
  label: string;
  event: string;
  hint: OnboardingHint | null;
}

/** Run a labelled sequence of events through a coach, capturing the active hint. */
function walk(coach: OnboardingCoach, steps: Array<{ label: string; event: OnboardingEvent }>): Frame[] {
  return steps.map(({ label, event }) => ({
    label,
    event: event.type,
    hint: coach.send(event),
  }));
}

const noviceStorage = memoryStorage();
const novice = walk(new OnboardingCoach({ storage: noviceStorage }), [
  { label: "Arrivée sur la fresque", event: { type: "arrive" } },
  { label: "1ʳᵉ visée (survol / case)", event: { type: "aim" } },
  { label: "Stage une case", event: { type: "stage" } },
  { label: "1ᵉʳ pixel posé (aha)", event: { type: "placed" } },
  { label: "1ʳᵉ jauge vide", event: { type: "gauge-empty", params: { seconds: 9 } } },
  { label: "1ᵉʳ seuil de réserve", event: { type: "gauge-grew", params: { max: 6 } } },
]);

const connoisseur = walk(new OnboardingCoach(), [
  { label: "Arrivée", event: { type: "arrive" } },
  { label: "Agit tout de suite (stage)", event: { type: "stage" } },
  { label: "Hésitation simulée (idle) → court-circuitée", event: { type: "idle" } },
  { label: "Mur (cap/locked) → aide proposée quand même", event: { type: "blocked-attempt" } },
]);

// Returning connaisseur: the seen steps + experienced profile persist.
const returning = walk(new OnboardingCoach({ storage: noviceStorage }), [
  { label: "Retour (arrival déjà vu)", event: { type: "arrive" } },
  { label: "Re-visée (aim déjà absorbé)", event: { type: "aim" } },
]);

function render(template: string | undefined, params?: MessageParams): string {
  return template ? interpolate(template, params) : "—";
}

function banner(hint: OnboardingHint | null): string {
  if (!hint) {
    return `<div class="none">∅ aucun hint (court-circuité / absorbé)</div>`;
  }
  const enText = render(en[hint.messageKey], hint.params);
  const frText = render(fr[hint.messageKey], hint.params);
  const dismiss = hint.dismissible ? `<button>${render(fr["canvas.onboarding.dismiss"])}</button>` : "";
  return `
    <div class="pair">
      <div class="onboard"><span>${frText}</span>${dismiss}</div>
      <div class="onboard en"><span>${enText}</span>${hint.dismissible ? `<button>${render(en["canvas.onboarding.dismiss"])}</button>` : ""}</div>
      <div class="meta">step=<b>${hint.step}</b> · key=<code>${hint.messageKey}</code> · autoHide=${hint.autoHideMs ?? "—"} · dismissible=${hint.dismissible}</div>
    </div>`;
}

function rows(frames: Frame[]): string {
  return frames
    .map(
      (f) => `
      <tr>
        <td class="step">${f.label}<br><small>send(${f.event})</small></td>
        <td>${banner(f.hint)}</td>
      </tr>`,
    )
    .join("");
}

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>FEN-118 — Onboarding viewer adaptatif (walkthrough)</title>
<style>
  body { background:#0a0e16; color:#d9ecff; font:15px/1.4 system-ui,sans-serif; margin:0; padding:28px; }
  h1 { font-size:20px; } h2 { margin-top:36px; font-size:16px; color:#9fc3ff; }
  p.sub { color:#7f9bbf; max-width:760px; }
  table { border-collapse:collapse; width:100%; max-width:1000px; margin-top:12px; }
  td { border-top:1px solid #1c2740; padding:14px 10px; vertical-align:top; }
  td.step { width:230px; color:#aebfd6; } td.step small { color:#6c84a8; }
  .pair { display:flex; flex-direction:column; gap:8px; }
  .onboard { display:inline-flex; align-items:center; gap:12px; max-width:520px;
    background:rgba(8,16,28,0.9); border:1px solid #2a4a6a; color:#d9ecff;
    padding:9px 14px; border-radius:999px; }
  .onboard.en { border-color:#3a4a2a; background:rgba(14,20,8,0.9); color:#e8ffd9; }
  .onboard button { background:transparent; border:1px solid #3a5a7a; color:inherit;
    padding:3px 10px; border-radius:999px; font-weight:600; }
  .meta { color:#6c84a8; font-size:12px; } .meta code { color:#9fc3ff; }
  .none { color:#6c84a8; font-style:italic; }
  .tag { display:inline-block; background:#1c2740; color:#9fc3ff; border-radius:6px; padding:1px 7px; font-size:12px; }
</style></head>
<body>
<h1>FEN-118 — Onboarding viewer adaptatif (just-in-time) · walkthrough</h1>
<p class="sub">Chaque ligne = un événement réel envoyé au <code>OnboardingCoach</code>. Le hint affiché est
résolu via les vrais catalogues <code>@canvas/i18n</code> (FR en bleu, EN en vert → <b>parité FR/EN</b>).
Rien ne bloque l'action ; au plus un hint à la fois ; un hint absorbé ne réapparaît jamais.</p>

<h2><span class="tag">Néophyte (Léa)</span> — apprend quoi / comment / coût avant son 1ᵉʳ échec</h2>
<table>${rows(novice)}</table>

<h2><span class="tag">Connaisseur (Max)</span> — agit tout de suite, jamais bloqué par un tuto</h2>
<table>${rows(connoisseur)}</table>

<h2><span class="tag">Retour</span> — persistance « vu » par étape (nouvelle session, même stockage)</h2>
<table>${rows(returning)}</table>
</body></html>`;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../artifacts/onboarding-walkthrough.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out}`);
