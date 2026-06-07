import MobileScene from "../components/MobileScene.jsx";

/**
 * MobileRefonte — the FEN-337 deliverable surface: the Arcade mobile target,
 * shown at REAL device sizes (390×844 portrait / 844×390 landscape) inside neutral
 * bezels so Alexis judges the actual rendering, plus the N=40 overflow proof and a
 * defect→fix legend tying every frame back to the FEN-336 acceptance criteria.
 */

function Phone({ w, h, label, children }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <div
        className="overflow-hidden rounded-[28px] border border-[#cfcfd4] bg-black shadow-[0_8px_24px_rgba(24,24,28,.16)]"
        style={{ padding: 6 }}
      >
        <div className="overflow-hidden rounded-[22px] bg-white" style={{ width: w, height: h }}>
          {children}
        </div>
      </div>
      <figcaption className="text-center text-[12px] font-semibold text-[#52525b]">{label}</figcaption>
    </figure>
  );
}

const FIXES = [
  ["Topbar", "Une barre fine opaque : wordmark + compteur live discret + menu ≡ (Galerie / Aide / Langue / Se déconnecter rangés). Aucune action destructrice exposée.", "AC-3"],
  ["Réserve", "Compteur + jauge de capacité bornée (N / cap). 20 ou 40 pixels : même largeur, jamais coupée par les bords. Fin du débordement #1.", "AC-1 · AC-2"],
  ["Canvas", "Plein cadre, zoomé sur une zone vivante, encadré Arcade. Le canvas est roi ; « Poser » au pouce dans le dock bas.", "AC-4"],
  ["Identité", "Accent corail + wordmark display, barres connectées (plus de 3 îlots sur gris mort). Tokens + composants Foundation uniquement.", "AC-5 · AC-7"],
  ["Paysage", "Chrome flottant minimal sur le canvas + rail de contrôles à droite : pas de débordement vertical, dock atteignable.", "AC-8"],
];

export default function MobileRefonte() {
  return (
    <div className="bg-[#dddde1] p-6">
      <div className="mx-auto max-w-[1320px]">
        <header className="mb-5">
          <h2 className="m-0 text-[20px] font-bold text-[#18181c]">Refonte mobile — cible Arcade</h2>
          <p className="mt-1 text-[13px] text-[#52525b]">
            FEN-337 · Étape 2. Rendu réel React + Tailwind + tokens Foundation. Le canvas devient roi, la topbar
            s'épure, et la réserve de pixels ne déborde plus (jauge bornée, identique à N=20 ou N=40).
          </p>
        </header>

        {/* Portrait states */}
        <div className="flex flex-wrap items-start gap-7">
          <Phone w={390} h={844} label="Portrait · Prêt à poser">
            <MobileScene orientation="portrait" placeState="ready" reserve={20} />
          </Phone>
          <Phone w={390} h={844} label="Portrait · Recharge (cooldown)">
            <MobileScene orientation="portrait" placeState="cooldown" reserve={6} />
          </Phone>
          <Phone w={390} h={844} label="Portrait · Réserve pleine N=40 (preuve anti-débordement)">
            <MobileScene orientation="portrait" placeState="ready" reserve={40} />
          </Phone>
        </div>

        {/* Landscape */}
        <div className="mt-8 flex flex-wrap items-start gap-7">
          <Phone w={844} h={390} label="Paysage · Prêt — canvas plein + rail de contrôles">
            <MobileScene orientation="landscape" placeState="ready" reserve={24} />
          </Phone>
        </div>

        {/* Defect → fix legend */}
        <div className="mt-8 rounded-[14px] border border-[#cfcfd4] bg-white p-5">
          <h3 className="m-0 mb-3 text-[14px] font-bold uppercase tracking-wide text-[#52525b]">Défaut → correctif (FEN-336)</h3>
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
            {FIXES.map(([title, body, ac]) => (
              <li key={title} className="flex gap-3 rounded-[10px] bg-[#f7f7f8] p-3">
                <span className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-[6px] bg-[#fde3df] px-2 text-[11px] font-bold text-[#bd3221]">{title}</span>
                <div>
                  <p className="m-0 text-[13px] leading-snug text-[#18181c]">{body}</p>
                  <span className="mt-1 inline-block text-[11px] font-semibold text-[#6c6c76]">{ac}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
