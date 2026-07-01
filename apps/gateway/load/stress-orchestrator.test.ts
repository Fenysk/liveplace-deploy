/**
 * FEN-1280 — unit coverage for the stress orchestrator's pure logic: metric
 * aggregation, SLO verdict, zone slicing, and report rendering. The live ramp
 * (network) is proven separately by `load/stress-dryrun.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summariseWindow,
  sliceZone,
  generateReport,
  DEFAULT_SLO,
  type OrchestratorResult,
  type StageMetrics,
} from "./stress-orchestrator";
import type { PlacementRecord } from "./convex-stress";

function rec(partial: Partial<PlacementRecord>): PlacementRecord {
  return {
    cid: "c",
    x: 0,
    y: 0,
    color: 5,
    sentAtMs: 1000,
    outcome: "ack",
    ...partial,
  };
}

test("summariseWindow: cooldowns are excluded from the error rate", () => {
  const records: PlacementRecord[] = [
    rec({ outcome: "ack", ackLatencyMs: 10 }),
    rec({ outcome: "ack", ackLatencyMs: 20 }),
    rec({ outcome: "cooldown" }),
    rec({ outcome: "cooldown" }),
    rec({ outcome: "error_other" }),
  ];
  const m = summariseWindow("s", 10, 2, records, 1000, DEFAULT_SLO);
  assert.equal(m.accepted, 2);
  assert.equal(m.cooldown, 2);
  assert.equal(m.errors, 1);
  // denom = 5 attempts − 2 cooldowns = 3; 1 error ⇒ 33.333%
  assert.equal(m.errorRatePct, 33.333);
});

test("summariseWindow: only sampled placements count toward pixel loss", () => {
  const records: PlacementRecord[] = [
    rec({ outcome: "ack", ackLatencyMs: 5, propagationSampled: true, propagationMs: 40 }),
    rec({ outcome: "ack", ackLatencyMs: 5, propagationSampled: true }), // sampled, never observed ⇒ lost
    rec({ outcome: "ack", ackLatencyMs: 5, propagationSampled: false }), // NOT sampled ⇒ not a loss
  ];
  const m = summariseWindow("s", 3, 3, records, 1000, DEFAULT_SLO);
  assert.equal(m.propagationSampled, 2);
  assert.equal(m.pixelsLostSampled, 1);
  assert.equal(m.prop.samples, 1); // only the observed one has a latency sample
  assert.ok(m.sloBreaches.some((b) => b.includes("pixel")));
  assert.equal(m.sloPass, false);
});

test("summariseWindow: throughput is accepted-per-second over the window", () => {
  const records = Array.from({ length: 20 }, () => rec({ outcome: "ack", ackLatencyMs: 1 }));
  const m = summariseWindow("s", 5, 5, records, 2000, DEFAULT_SLO);
  assert.equal(m.accepted, 20);
  assert.equal(m.throughputPerSec, 10); // 20 / 2s
});

test("summariseWindow: ack p95 over SLO is a breach", () => {
  const records = [
    ...Array.from({ length: 80 }, () => rec({ outcome: "ack", ackLatencyMs: 100 })),
    ...Array.from({ length: 20 }, () => rec({ outcome: "ack", ackLatencyMs: 900 })),
  ];
  const m = summariseWindow("hot", 100, 50, records, 1000, DEFAULT_SLO);
  assert.ok(m.ack.p95 > DEFAULT_SLO.ackP95Ms);
  assert.equal(m.sloPass, false);
  assert.ok(m.sloBreaches.some((b) => b.startsWith("ack p95")));
});

test("sliceZone: cells are non-overlapping and inside the parent zone", () => {
  const parent = { x: 0, y: 0, w: 100, h: 100 };
  const cells = sliceZone(parent, 9);
  assert.equal(cells.length, 9);
  for (const c of cells) {
    assert.ok(c.x >= parent.x && c.y >= parent.y);
    assert.ok(c.x + c.w <= parent.x + parent.w + 1); // floor rounding tolerance
    assert.ok(c.w >= 1 && c.h >= 1);
  }
  // No two cells share an origin (distinct regions).
  const origins = new Set(cells.map((c) => `${c.x}:${c.y}`));
  assert.equal(origins.size, 9);
});

function fakeResult(stages: StageMetrics[], over: Partial<OrchestratorResult> = {}): OrchestratorResult {
  return {
    dryRun: false,
    startedAt: "2026-06-28T00:00:00.000Z",
    finishedAt: "2026-06-28T00:01:00.000Z",
    durationMs: 60_000,
    config: { wsUrl: "ws://x", stages: [], activeFraction: 0.15, propagationSampleRate: 0.25 },
    slo: DEFAULT_SLO,
    guardrails: { abortErrorRatePct: 5, abortAckP95MultipleOfSlo: 3 },
    stages,
    aborted: false,
    abortReason: null,
    breakingPoint: null,
    maxSustainedActors: 0,
    recovery: null,
    cooldownWaits: { count: 0, p50Ms: 0, maxMs: 0 },
    ...over,
  };
}

test("generateReport: GO when every stage passes, NO-GO with a breaking point", () => {
  const pass = summariseWindow("ok", 100, 15, [rec({ outcome: "ack", ackLatencyMs: 50 })], 1000, DEFAULT_SLO);
  const goReport = generateReport(fakeResult([pass], { maxSustainedActors: 100 }));
  assert.ok(goReport.markdown.includes("**GO**"));
  assert.ok(goReport.json.length > 0);

  const fail = summariseWindow(
    "break",
    3000,
    450,
    Array.from({ length: 100 }, () => rec({ outcome: "ack", ackLatencyMs: 1200 })),
    1000,
    DEFAULT_SLO,
  );
  const noGo = generateReport(
    fakeResult([pass, fail], {
      breakingPoint: { label: "break", actors: 3000, reason: fail.sloBreaches.join("; ") },
      maxSustainedActors: 100,
    }),
  );
  assert.ok(noGo.markdown.includes("NO-GO"));
  assert.ok(noGo.markdown.includes("break"));
});

test("generateReport: dry-run verdict keys off captured samples, not SLO pass", () => {
  const m = summariseWindow("warm", 4, 2, [rec({ outcome: "ack", ackLatencyMs: 5 })], 1000, DEFAULT_SLO);
  const r = generateReport(fakeResult([m], { dryRun: true }));
  assert.ok(r.markdown.includes("Instrumentation validated"));
});
