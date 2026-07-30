import { useCallback, useEffect, useRef, useState } from "react";

// SOUND_DEFAULT = OFF — pending Alexis §7-2 arbitrage. Flip this constant once
// the CEO confirms the default. All persistence uses localStorage so the user's
// choice always overrides this value after the first toggle.
const SOUND_DEFAULT = false;
const THROTTLE_MS = 300; // AC1: ≥300ms between pose sounds (no spam in continuous paint)

export interface SoundEngine {
  soundEnabled: boolean;
  setSoundEnabled: (on: boolean) => void;
  autoplayBlocked: boolean;
  playPose: () => void;
  playGaugeFull: () => void;
}

export function useSoundEngine(): SoundEngine {
  const [soundEnabled, setSoundEnabledRaw] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("lp:sound:enabled");
      return stored !== null ? stored === "true" : SOUND_DEFAULT;
    } catch {
      return SOUND_DEFAULT;
    }
  });

  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const lastPoseRef = useRef(0);
  // Refs so bound-once callbacks always read the current value without closure stale.
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  const getCtx = useCallback((): AudioContext | null => {
    try {
      if (!ctxRef.current) {
        ctxRef.current = new AudioContext();
      }
      if (ctxRef.current.state === "suspended") {
        void ctxRef.current.resume().catch(() => {
          setAutoplayBlocked(true);
        });
      }
      return ctxRef.current;
    } catch {
      setAutoplayBlocked(true);
      return null;
    }
  }, []);

  // AC1: short pop on confirmed pixel placement, throttled to ≥300ms.
  // WebAudio synthesis (no file dependency) — square wave pitch-sweep 880→440Hz.
  const playPose = useCallback(() => {
    if (!soundEnabledRef.current) return;
    if (document.hidden) return; // spec §6: no sound in background tab
    const now = Date.now();
    if (now - lastPoseRef.current < THROTTLE_MS) return;
    lastPoseRef.current = now;
    try {
      const ctx = getCtx();
      if (!ctx || ctx.state === "suspended") return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.linearRampToValueAtTime(440, t + 0.08);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.003); // fast attack, anti-click
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11); // short decay
      osc.start(t);
      osc.stop(t + 0.115);
    } catch {
      setAutoplayBlocked(true);
    }
  }, [getCtx]);

  // AC2: reward jingle when gauge reaches full (1× per transition, not per tick).
  // Ascending triad C5→E5→G5, triangle wave, chiptune register (~546ms total).
  const playGaugeFull = useCallback(() => {
    if (!soundEnabledRef.current) return;
    if (document.hidden) return;
    try {
      const ctx = getCtx();
      if (!ctx || ctx.state === "suspended") return;
      const t = ctx.currentTime;
      const notes: Array<{ freq: number; start: number; dur: number }> = [
        { freq: 523.25, start: 0.0,  dur: 0.18 },
        { freq: 659.25, start: 0.15, dur: 0.18 },
        { freq: 783.99, start: 0.30, dur: 0.25 },
      ];
      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "triangle";
        osc.frequency.value = note.freq;
        const st = t + note.start;
        gain.gain.setValueAtTime(0, st);
        gain.gain.linearRampToValueAtTime(0.18, st + 0.010);
        gain.gain.exponentialRampToValueAtTime(0.001, st + note.dur);
        osc.start(st);
        osc.stop(st + note.dur + 0.005);
      }
    } catch {
      setAutoplayBlocked(true);
    }
  }, [getCtx]);

  const setSoundEnabled = useCallback(
    (on: boolean) => {
      setSoundEnabledRaw(on);
      try {
        localStorage.setItem("lp:sound:enabled", on ? "true" : "false");
      } catch { /* quota errors must not break anything */ }
      // Unlock AudioContext on the first user gesture that enables sound (AC5).
      if (on) void getCtx();
    },
    [getCtx],
  );

  // AC5: if AudioContext is blocked (autoplay policy) the engine silently stays
  // mute — no visible error, UI remains coherent. The `autoplayBlocked` flag
  // lets the toggle render the disabled/barred state.
  useEffect(() => {
    return () => {
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return { soundEnabled, setSoundEnabled, autoplayBlocked, playPose, playGaugeFull };
}
