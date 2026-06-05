import FrescoCanvas from "../components/FrescoCanvas.jsx";
import Button from "../components/ui/Button.jsx";
import Wordmark from "../components/Wordmark.jsx";

/**
 * Moment de célébration — signature screen (cadrage §8.1.4): the Kano delighter.
 * Fires on a milestone (fresque complete / personal streak / community goal).
 * Arcade direction OWNS this moment: amber+coral confetti, pixel-pop, the
 * Press Start wordmark — "fun in the feedback". Honors reduced-motion (confetti
 * collapses to a static badge via .lp-confetti / --da-motion-scale = 0).
 */
function Confetti() {
  const cols = ["var(--accent)", "var(--accent-2)", "#ffe14d", "#16b8a6", "#4ab6f0", "#d64ab0"];
  const bits = Array.from({ length: 28 }).map((_, i) => {
    const left = (i * 37) % 100;
    const delay = (i % 7) * 90;
    const size = 6 + (i % 3) * 3;
    return (
      <span
        key={i}
        className="lp-confetti absolute top-0 rounded-[1px]"
        style={{
          left: `${left}%`,
          width: size, height: size,
          background: cols[i % cols.length],
          // Loop in the maquette so the celebratory confetti is always visible
          // in a still capture; in product this runs once (forwards) then clears.
          animation: `lp-confetti-fall calc(1300ms * var(--da-motion-scale,1)) var(--ease-out) ${delay}ms infinite`,
        }}
      />
    );
  });
  return <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">{bits}</div>;
}

export default function Celebration({ viewport = "desktop" }) {
  const big = viewport !== "mobile";
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden" style={{ background: "var(--ui-bg)" }}>
      {/* faded fresco behind, hero badge in front */}
      <div className="absolute inset-0 grid place-items-center opacity-25">
        <FrescoCanvas cell={big ? 14 : 8} />
      </div>
      <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 50% 38%, transparent, var(--ui-bg) 72%)" }} />
      <Confetti />

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <div
          className="lp-pop grid h-24 w-24 place-items-center rounded-[var(--da-radius-card)] shadow-[var(--elev-3)]"
          style={{ background: "var(--accent)", color: "var(--accent-onAccent)" }}
        >
          <svg width="52" height="52" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2.2l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.27 6.1 20.37l1.13-6.57L2.45 9.14l6.6-.96L12 2.2z" />
          </svg>
        </div>
        <p className="mt-5 text-[var(--text-sm)] font-semibold uppercase tracking-[0.18em] text-[var(--accent-text)]">
          Fresque complétée !
        </p>
        <h1
          className="mt-2 text-[var(--text-3xl)] font-bold leading-tight text-[var(--ui-text)]"
          style={{ fontFamily: "var(--font-display)", fontSize: big ? 30 : 22, lineHeight: 1.25 }}
        >
          396 joueurs,<br />8 530 pixels.
        </h1>
        <p className="mt-3 max-w-[420px] text-[var(--text-base)] text-[var(--ui-text-secondary)]">
          La commu vient de finir la fresque ensemble. Ton pixel y est pour toujours.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" icon={<span aria-hidden>↗</span>}>Partager la fresque</Button>
          <Button size="lg" variant="secondary">Revoir le timelapse</Button>
        </div>
        <div className="mt-8 opacity-70"><Wordmark size="sm" /></div>
      </div>
    </div>
  );
}
