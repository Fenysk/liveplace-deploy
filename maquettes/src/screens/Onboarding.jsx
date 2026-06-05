import FrescoCanvas from "../components/FrescoCanvas.jsx";
import Button from "../components/ui/Button.jsx";
import Wordmark from "../components/Wordmark.jsx";
import TwitchGlyph from "../components/ui/TwitchGlyph.jsx";

/**
 * Onboarding + connexion Twitch — signature screen (cadrage §8.1.2).
 * Job: in <5s a viewer understands "place a pixel on the streamer's fresco
 * with my Twitch account". One promise, one primary action (connect Twitch),
 * canvas-as-hero behind. Arcade direction: coral accent, square pixel-corners
 * on the signature CTA, Press Start wordmark, the live "place-pop" wink.
 */
const TWITCH = "#9146FF"; // brand-locked: Twitch purple is fixed, not a token.

function ConnectCard({ compact = false }) {
  return (
    <div
      className="w-full rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-5 shadow-[var(--elev-3)]"
      style={{ maxWidth: compact ? "100%" : 380 }}
    >
      <Wordmark size="lg" />
      <h1 className="mt-3 text-[var(--text-2xl)] font-bold leading-tight text-[var(--ui-text)]">
        Pose ton pixel sur la fresque en live.
      </h1>
      <p className="mt-2 text-[var(--text-sm)] text-[var(--ui-text-secondary)]">
        Une fresque, toute la commu, en direct sur Twitch. Connecte-toi : ta réserve de
        pixels se recharge toute seule.
      </p>

      <Button
        size="lg"
        className="mt-5 w-full"
        icon={<TwitchGlyph size={18} />}
        style={{ background: TWITCH, color: "#fff" }}
      >
        Se connecter avec Twitch
      </Button>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[var(--text-xs)] text-[var(--ui-text-tertiary)]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 1.6a5 5 0 00-5 5v2.4H6a2 2 0 00-2 2V20a2 2 0 002 2h12a2 2 0 002-2v-7a2 2 0 00-2-2h-1V6.6a5 5 0 00-5-5zm3 7.4H9V6.6a3 3 0 116 0V9z" />
        </svg>
        On lit juste ton pseudo. Aucun message envoyé en ton nom.
      </p>

      <div className="mt-4 flex items-center gap-3 text-[var(--text-xs)] text-[var(--ui-text-tertiary)]">
        <span className="h-px flex-1" style={{ background: "var(--ui-border)" }} />
        ou
        <span className="h-px flex-1" style={{ background: "var(--ui-border)" }} />
      </div>
      <Button variant="secondary" size="md" className="mt-4 w-full">
        Regarder sans poser
      </Button>
    </div>
  );
}

export default function Onboarding({ viewport = "desktop" }) {
  if (viewport === "mobile") {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--ui-bg)]">
        <div className="relative flex-1 overflow-hidden">
          <div className="absolute inset-0 grid place-items-center p-4 opacity-95">
            <div className="rounded-[var(--radius-md)] p-1.5 shadow-[var(--elev-2)]" style={{ background: "var(--canvas-frame)" }}>
              <FrescoCanvas cell={7} />
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(to top, var(--ui-bg) 38%, transparent)" }} />
        </div>
        <div className="px-4 pb-6 -mt-24 relative">
          <ConnectCard compact />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full w-full grid-cols-[1.15fr_minmax(380px,.85fr)] bg-[var(--ui-bg)]">
      {/* hero — the canvas IS the pitch (canvas roi) */}
      <div className="relative grid place-items-center overflow-hidden p-8">
        <div className="rounded-[var(--radius-lg)] p-2 shadow-[var(--elev-3)]" style={{ background: "var(--canvas-frame)" }}>
          <FrescoCanvas cell={13} />
        </div>
        <span className="absolute left-8 top-8 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--ui-surface-raised)] px-3 py-1.5 text-[var(--text-xs)] font-semibold shadow-[var(--elev-2)]">
          <span aria-hidden style={{ color: "var(--status-open-fg)" }}>●</span> En direct · 1 248 regardent
        </span>
      </div>
      {/* connect rail */}
      <div className="grid place-items-center border-l border-[var(--ui-border)] bg-[var(--ui-surface)] p-8">
        <ConnectCard />
      </div>
    </div>
  );
}
