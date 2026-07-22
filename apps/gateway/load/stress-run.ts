/**
 * FEN-1280 — Stress-test RUNNER CLI (re-jouable). Drives the production
 * {@link StressOrchestrator} against a real gateway following the plan §4 dynamic
 * profile (0 → 500 → 1000 → 2000 → peak 3000), prints the go/no-go report, and
 * writes the markdown + JSON artifacts.
 *
 * ⚠️ This puts the TARGET gateway under heavy load. The PRODUCTION run is a
 * separate, GATED issue (plan §7/§8): it touches prod and requires Alexis's sign-off
 * + an off-peak window + monitoring. To guard against an accidental prod run, the
 * CLI refuses to start against a non-localhost target unless STRESS_CONFIRM=1 is set.
 * The kill-switch is SIGINT (Ctrl-C) or SIGTERM — tested in the dry-run.
 *
 * Run (local/staging):
 *   WS_URL=ws://127.0.0.1:8080 DEV_SECRET=<secret> \
 *     pnpm --filter @canvas/gateway exec tsx load/stress-run.ts
 *
 * Run (gated prod, off-peak, with sign-off):
 *   STRESS_CONFIRM=1 WS_URL=wss://stress-host DEV_SECRET=<secret> \
 *     pnpm --filter @canvas/gateway exec tsx load/stress-run.ts
 *
 * ⚠️ TARGET = a DEDICATED STRESS GATEWAY, not the primary host. Isolate at the
 * canvas-id level, not the URL: run a SECOND gateway instance (same image, same
 * prod Redis + Convex) pinned to `GATEWAY_CANVAS_ID=stress-YYYYMMDD` on its own WS
 * endpoint and point WS_URL there — every write it accepts lands in that namespace,
 * and its own worker drains it, so the live `default` art and the prod gateway
 * process stay untouched. (The gateway is multi-canvas since FEN-1573, but the
 * persistence worker is still mono-canvas, so a dedicated worker is needed anyway.)
 * Writes then live in `canvas:stress-YYYYMMDD:*` (Redis) + Convex placements
 * authored by `loadtest:user:*` → isolated + cleanable; the live canvas is
 * untouched. (Pattern: docker-compose.loadtest.fanout.yml.)
 * AUTH = per-user dev-JWT via DEV_SECRET (each actor gets its own gauge bucket);
 * tokenless = read-only, and GATEWAY_AUTH_DISABLED shares one gauge:anon — neither
 * drives the write path (FEN-532). See the FEN-1279 thread for the full go/no-go.
 *
 * Profile env overrides (DevOps-agreed ramp = STAGES="200:60,800:60,1500:60,3000:60"):
 *   STAGES="500:300,1000:300,2000:600,3000:180"  (actors:holdSeconds, comma-sep)
 *   ACTIVE_FRACTION=0.15  PROP_SAMPLE=0.05  PLACE_INTERVAL_MS=0
 *   ZONE="0,0,512,512"  OBSERVERS=4
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StressOrchestrator,
  generateReport,
  DEFAULT_SLO,
  type RampStage,
  type Zone,
} from "./stress-orchestrator";

function parseStages(s: string | undefined): RampStage[] {
  // Default: plan §4 — paliers 500/1000/2000 (5 min plateau cible 2000) + pic 3000.
  const spec = s ?? "500:180,1000:180,2000:600,3000:180";
  return spec.split(",").map((part) => {
    const [actorsStr, holdStr] = part.split(":");
    const actors = Number(actorsStr);
    const holdSec = Number(holdStr ?? "180");
    if (!Number.isFinite(actors) || actors <= 0) throw new Error(`bad stage actors: ${part}`);
    return { label: `palier-${actors}`, actors, holdMs: holdSec * 1000 };
  });
}

function parseZone(s: string | undefined): Zone | undefined {
  if (!s) return undefined;
  const [x, y, w, h] = s.split(",").map(Number);
  if ([x, y, w, h].some((v) => v === undefined || !Number.isFinite(v) || v < 0)) return undefined;
  return { x: x!, y: y!, w: w!, h: h! };
}

function isLocal(url: string): boolean {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

async function main(): Promise<void> {
  const wsUrl = process.env.WS_URL;
  const devSecret = process.env.DEV_SECRET;
  if (!wsUrl || !devSecret) {
    console.error("FATAL: WS_URL and DEV_SECRET are required.");
    process.exit(2);
  }
  if (!isLocal(wsUrl) && process.env.STRESS_CONFIRM !== "1") {
    console.error(
      `REFUSING to stress a non-local target (${wsUrl}) without STRESS_CONFIRM=1.\n` +
        "The production run is a GATED issue: get Alexis's sign-off + an off-peak window first (plan §8).",
    );
    process.exit(3);
  }

  const stages = parseStages(process.env.STAGES);
  const orch = new StressOrchestrator({
    wsUrl,
    devSecret,
    stages,
    activeFraction: Number(process.env.ACTIVE_FRACTION ?? 0.15),
    propagationSampleRate: Number(process.env.PROP_SAMPLE ?? 0.05),
    placeIntervalMs: Number(process.env.PLACE_INTERVAL_MS ?? 0),
    zone: parseZone(process.env.ZONE) ?? { x: 0, y: 0, w: 512, h: 512 },
    observerCount: Number(process.env.OBSERVERS ?? 4),
    slo: DEFAULT_SLO,
    measureRecovery: true,
    dryRun: false,
  });

  console.log(`[stress-run] target=${wsUrl} stages=${stages.map((s) => s.actors).join("→")} (Ctrl-C = kill-switch)`);
  const result = await orch.run();

  const { markdown, json } = generateReport(result);
  console.log("\n" + markdown + "\n");

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "results");
  mkdirSync(dir, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  writeFileSync(join(dir, `stress-run-${stamp}.md`), markdown);
  writeFileSync(join(dir, `stress-run-${stamp}.json`), json);
  console.log(`[stress-run] report → ${dir}/stress-run-${stamp}.{md,json}`);

  // Exit non-zero on a NO-GO so a CI/monitoring wrapper can react.
  const go = result.stages.length > 0 && result.stages.every((s) => s.sloPass) && !result.aborted;
  process.exit(go ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("[stress-run] fatal:", err);
  process.exit(2);
});
