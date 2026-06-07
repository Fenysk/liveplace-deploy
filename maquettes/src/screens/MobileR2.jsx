import MobileSceneR2 from "../components/MobileSceneR2.jsx";

/**
 * MobileR2 — the FEN-368 deliverable surface (Round 2). Shows the bottom-panel
 * states (open / closed + reopen), free pan, and the extended dezoom ("vue
 * d'ensemble"), in the Arcade identity, at real device sizes. The first phone is
 * LIVE (drag / zoom / close-reopen actually work) so Alexis can try it; the rest
 * are the same component pinned to a state so the spec reads at a glance.
 */

function Phone({ w, h, label, sub, children }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <div className="overflow-hidden rounded-[28px] border border-[#cfcfd4] bg-black shadow-[0_8px_24px_rgba(24,24,28,.16)]" style={{ padding: 6 }}>
        <div className="overflow-hidden rounded-[22px] bg-white" style={{ width: w, height: h }}>{children}</div>
      </div>
      <figcaption className="max-w-[230px] text-center">
        <span className="block text-[12px] font-semibold text-[#18181c]">{label}</span>
        {sub && <span className="mt-0.5 block text-[11px] leading-snug text-[#6c6c76]">{sub}</span>}
      </figcaption>
    </figure>
  );
}

const FRICTIONS = [
  ["F1", "P0", "Faux handle", "Le handle décoratif devient un PanelHandle réel : on le glisse (ou × / clavier) pour fermer ; une pastille de réouverture le ramène. Zéro fausse affordance."],
  ["F2", "P0", "Pan bloqué", "Le canvas se déplace librement, y compris vers le haut panneau ouvert. Le clamp se cale sur la zone VISIBLE (hors panneau) : toute case redevient atteignable."],
  ["F3", "P0", "Dézoom plafonné", "Le plancher de zoom = fit-to-screen. Le bouton ⊡ « voir toute la fresque » donne la vue d'ensemble ; plage de dézoom nettement élargie."],
  ["F4", "P1", "Gestes invisibles", "Astuce premier-usage (une fois, dismissible) + boutons +/−/⊡ explicites : le pinch seul n'était pas découvrable."],
  ["F6", "P1", "Panneau trop haut", "Plafond --dock-max-h → le canvas garde la main ; fermable à tout moment pour revenir plein écran."],
  ["F7", "P1", "Conflit de gestes", "La fermeture n'est captée que sur le PanelHandle (zone de saisie dédiée) ; le swipe sur le canvas reste un pan. Pas de chevauchement."],
  ["F8–F11", "P2", "Superpositions / motion", "Toasts & FAB ne se masquent pas (z-tokens) ; toutes les nouvelles transitions respectent prefers-reduced-motion (saut direct)."],
];

const ARBITRAGES = [
  ["A1", "Palier mi-hauteur ?", "Ouvert / Fermé seulement (P0). Mi-hauteur = confort P2.", "Ouvert/Fermé"],
  ["A2", "État par défaut à l'arrivée", "Ouvert si connecté ; anonyme ouvert compact. Persister le dernier état (localStorage).", "Ouvert + persisté"],
  ["A3", "Marge anti-perte du pan", "≥ ~20 % de la fresque toujours visible au pan extrême (token --pan-overscroll-min).", "~20 %"],
  ["A4", "Dézoom au-delà du fit ?", "S'arrêter pile au fit-to-screen ; léger cran de contexte en option.", "Pile au fit"],
  ["A5", "Double-tap", "Double-tap = zoom-in vers le point ; second double-tap = retour fit.", "Zoom-in → fit"],
];

const sevColor = { P0: ["#fbe3dd", "#bd3221"], P1: ["#fbeccb", "#8a5a00"], P2: ["#e7e7ea", "#52525b"] };

export default function MobileR2() {
  return (
    <div className="bg-[#dddde1] p-6">
      <div className="mx-auto max-w-[1320px]">
        <header className="mb-5">
          <h2 className="m-0 text-[20px] font-bold text-[#18181c]">Round 2 — interactions mobiles · cible Arcade</h2>
          <p className="mt-1 max-w-[860px] text-[13px] leading-relaxed text-[#52525b]">
            FEN-368 · Étape 2. Réponse aux 3 frictions d'Alexis : <strong>panneau refermable/ouvrable</strong>,
            <strong> canvas déplaçable librement</strong>, <strong>dézoom étendu (vue d'ensemble)</strong>.
            Le 1<sup>er</sup> téléphone est <strong>vivant</strong> — glisse le canvas, zoome avec +/−/⊡, ferme le
            panneau (glisse le handle ou ×) puis rouvre-le avec la pastille de réouverture.
          </p>
        </header>

        {/* The state frames */}
        <div className="flex flex-wrap items-start gap-7">
          <Phone w={390} h={844} label="1 — LIVE · Panneau ouvert"
            sub="Essaie : glisse pour panner, +/− pour zoomer, glisse le handle vers le bas pour fermer.">
            <MobileSceneR2 orientation="portrait" placeState="ready" reserve={20} initialOpen initialView="detail" />
          </Phone>
          <Phone w={390} h={844} label="2 — Panneau fermé · canvas plein écran"
            sub="Pastille de réouverture (badge « 3 en cours » = batch conservé, Zeigarnik). Canvas 100 % interactif.">
            <MobileSceneR2 orientation="portrait" placeState="ready" reserve={20} initialOpen={false} staged={3} showHint={false} />
          </Phone>
          <Phone w={390} h={844} label="3 — Vue d'ensemble · dézoom étendu"
            sub="Fit-to-screen : toute la fresque visible (64×40). Plancher de zoom découplé de l'ancien cover-fit.">
            <MobileSceneR2 orientation="portrait" placeState="ready" reserve={20} initialOpen initialView="overview" showHint={false} />
          </Phone>
        </div>

        <div className="mt-8 flex flex-wrap items-start gap-7">
          <Phone w={844} h={390} label="4 — Paysage · panneau (rail droit) fermable"
            sub="Même modèle, fermeture horizontale ; réouverture par la pastille ancrée au bord gauche.">
            <MobileSceneR2 orientation="landscape" placeState="ready" reserve={24} initialOpen showHint={false} />
          </Phone>
          <Phone w={390} h={844} label="5 — Recharge · panneau ouvert"
            sub="Cooldown = TEMPS (Gauge), jamais un 2ᵉ compteur. Réserve = jauge bornée (anti-débordement).">
            <MobileSceneR2 orientation="portrait" placeState="cooldown" reserve={6} initialOpen showHint={false} />
          </Phone>
        </div>

        {/* Friction catalogue */}
        <div className="mt-8 rounded-[14px] border border-[#cfcfd4] bg-white p-5">
          <h3 className="m-0 mb-3 text-[14px] font-bold uppercase tracking-wide text-[#52525b]">Frictions ux-spec → correctif maquette</h3>
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
            {FRICTIONS.map(([id, sev, title, body]) => {
              const [bg, fg] = sevColor[sev];
              return (
                <li key={id} className="flex gap-3 rounded-[10px] bg-[#f7f7f8] p-3">
                  <span className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-[6px] px-2 text-[11px] font-bold" style={{ background: bg, color: fg }}>{id} · {sev}</span>
                  <div>
                    <p className="m-0 text-[13px] font-semibold leading-snug text-[#18181c]">{title}</p>
                    <p className="m-0 mt-0.5 text-[12px] leading-snug text-[#52525b]">{body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Arbitrages for Alexis */}
        <div className="mt-5 rounded-[14px] border border-[#cfcfd4] bg-white p-5">
          <h3 className="m-0 mb-1 text-[14px] font-bold uppercase tracking-wide text-[#52525b]">À arbitrer (Alexis) — défauts maquettés, variantes possibles</h3>
          <p className="m-0 mb-3 text-[12px] text-[#6c6c76]">La maquette montre le <strong>défaut recommandé</strong> ; rien ne bloque l'exec si Alexis valide tel quel.</p>
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0">
            {ARBITRAGES.map(([id, q, body, def]) => (
              <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-[#f7f7f8] p-3">
                <span className="inline-flex h-6 shrink-0 items-center rounded-[6px] bg-[#e6e6f4] px-2 text-[11px] font-bold text-[#4b4ea6]">{id}</span>
                <span className="text-[13px] font-semibold text-[#18181c]">{q}</span>
                <span className="basis-full text-[12px] leading-snug text-[#52525b] md:basis-auto md:flex-1">{body}</span>
                <span className="inline-flex shrink-0 items-center rounded-[6px] bg-[#dcf3e4] px-2 py-0.5 text-[11px] font-bold text-[#198547]">défaut : {def}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
