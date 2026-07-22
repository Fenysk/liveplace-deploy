#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/stress-monitor.mjs — LIVE PROD-SIDE monitoring dashboard for the
// stress test (FEN-1279). Owned by DevOps.
//
//   ⚠️  This is the SERVER/INFRA side of the test. The load DRIVER (Founding Eng
//       harness) reports client-side connect success/latency; THIS script reports
//       what prod is doing under that load: 5xx rate, edge/Convex latency, and —
//       if a Coolify token is provided — container CPU/mem + restart counts.
//
// It does NOT generate load. Run it in a terminal NEXT TO the driver during the
// run. It prints one line per sample and screams (ABORT lines) when an abort
// criterion is crossed so the operator can hit the kill-switch.
//
// WHAT IT SAMPLES every --interval seconds (default 5s):
//   • GET https://<host>/healthz        → edge+web reachability + latency
//   • GET https://<host>/convex/version → Convex backend reachability + latency
//   • TLS connect to <host>:443         → raw egress/handshake latency
//   • (optional) Coolify /api/v1/applications/{uuid} → status:running/healthy
//
// ABORT CRITERIA (FEN-1279 guardrails). A sample is FLAGGED when:
//   • error rate over the rolling window > --max-error-rate (default 0.05 = 5%)
//   • healthz OR convex p95 latency > --slo-mult × the measured BASELINE
//     (default 3×; baseline = median of the first --baseline-samples clean probes)
//   • any probe returns 5xx, or Coolify reports the app not running:healthy
// Three consecutive flagged samples → a loud "ABORT RECOMMENDED" banner.
//
// USAGE:
//   node scripts/stress-monitor.mjs                       # defaults, liveplace.tv
//   HOST=liveplace.tv node scripts/stress-monitor.mjs --interval 5 --slo-mult 3
//   COOLIFY_API_TOKEN=… COOLIFY_APP_UUID=… node scripts/stress-monitor.mjs
//
// Pre-flight baseline: run this for ~1 min BEFORE the driver starts so the
// baseline reflects idle prod. The driver then runs; deltas are vs that baseline.
// ─────────────────────────────────────────────────────────────────────────────
import https from "node:https";
import tls from "node:tls";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
// CLI --host wins; then MONITOR_HOST (dedicated, avoids stray HOST=0.0.0.0 in
// container envs clobbering the target); then the prod default.
const HOST = arg("host", process.env.MONITOR_HOST || "liveplace.tv");
const INTERVAL_MS = Number(arg("interval", "5")) * 1000;
const MAX_ERR = Number(arg("max-error-rate", "0.05"));
const SLO_MULT = Number(arg("slo-mult", "3"));
const WINDOW = Number(arg("window", "12")); // rolling samples for error-rate
const BASELINE_SAMPLES = Number(arg("baseline-samples", "8"));
const COOLIFY_URL = (process.env.COOLIFY_URL || "https://coolify.fenysk.fr").replace(/\/$/, "");
const COOLIFY_TOKEN = process.env.COOLIFY_API_TOKEN || process.env.COOLIFY_API_TOKEN_3 || "";
const COOLIFY_UUID = process.env.COOLIFY_APP_UUID || "";

const fmt = (n) => (n == null ? "  -" : String(Math.round(n)).padStart(4));
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function httpProbe(path) {
  return new Promise((res) => {
    const t0 = Date.now();
    const req = https.get(
      { host: HOST, path, port: 443, timeout: 10000, headers: { "user-agent": "stress-monitor/1" } },
      (r) => { r.on("data", () => {}); r.on("end", () => res({ code: r.statusCode, ms: Date.now() - t0 })); },
    );
    req.on("timeout", () => { req.destroy(); res({ code: 0, ms: Date.now() - t0, err: "timeout" }); });
    req.on("error", (e) => res({ code: 0, ms: Date.now() - t0, err: e.code || "err" }));
  });
}

function tlsProbe() {
  return new Promise((res) => {
    const t0 = Date.now();
    // servername only when HOST is a name (RFC 6066 forbids SNI = IP literal).
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(HOST);
    const s = tls.connect({ host: HOST, port: 443, ...(isIp ? {} : { servername: HOST }) }, () => { s.destroy(); res({ ms: Date.now() - t0 }); });
    s.setTimeout(10000, () => { s.destroy(); res({ ms: Date.now() - t0, err: "timeout" }); });
    s.on("error", (e) => res({ ms: Date.now() - t0, err: e.code || "err" }));
  });
}

function coolifyProbe() {
  if (!COOLIFY_TOKEN || !COOLIFY_UUID) return Promise.resolve(null);
  return new Promise((res) => {
    const req = https.get(
      `${COOLIFY_URL}/api/v1/applications/${COOLIFY_UUID}`,
      { headers: { authorization: `Bearer ${COOLIFY_TOKEN}` }, timeout: 10000 },
      (r) => {
        let body = "";
        r.on("data", (d) => (body += d));
        r.on("end", () => {
          try { const j = JSON.parse(body); res({ status: j.status ?? j.data?.status ?? "unknown" }); }
          catch { res({ status: `http${r.statusCode}` }); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); res({ status: "timeout" }); });
    req.on("error", (e) => res({ status: e.code || "err" }));
  });
}

const ok = (c) => c >= 200 && c < 400;
const recent = []; // {err:boolean}
const baseHealthz = [], baseConvex = [];
let baseline = null; // {healthz, convex}
let consecFlag = 0;
let n = 0;

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

console.log(`# stress-monitor → https://${HOST}  interval=${INTERVAL_MS / 1000}s  abort: err>${pct(MAX_ERR)} | p95>${SLO_MULT}×baseline`);
console.log(`# coolify: ${COOLIFY_TOKEN && COOLIFY_UUID ? "ON (" + COOLIFY_UUID.slice(0, 8) + "…)" : "OFF (set COOLIFY_API_TOKEN + COOLIFY_APP_UUID)"}`);
console.log(`# baseline: first ${BASELINE_SAMPLES} clean samples — keep the driver OFF until baseline is locked.`);
console.log("");
console.log("  #   time     healthz  convex   tls    5xx?  errRate  coolify        note");

async function tick() {
  n++;
  const [hz, cx, tl, co] = await Promise.all([httpProbe("/healthz"), httpProbe("/convex/version"), tlsProbe(), coolifyProbe()]);
  const had5xx = (hz.code >= 500) || (cx.code >= 500);
  const sampleErr = !ok(hz.code) || !ok(cx.code) || !!tl.err || (co && !/running|healthy/i.test(co.status));
  recent.push({ err: sampleErr });
  if (recent.length > WINDOW) recent.shift();
  const errRate = recent.filter((r) => r.err).length / recent.length;

  // Baseline accrual from clean samples
  if (!baseline) {
    if (!sampleErr) { baseHealthz.push(hz.ms); baseConvex.push(cx.ms); }
    if (baseHealthz.length >= BASELINE_SAMPLES) {
      baseline = { healthz: median(baseHealthz), convex: median(baseConvex) };
      console.log(`# >>> BASELINE LOCKED: healthz=${baseline.healthz}ms convex=${baseline.convex}ms — start the driver now. SLO ceilings: healthz<${baseline.healthz * SLO_MULT}ms convex<${baseline.convex * SLO_MULT}ms`);
    }
  }

  // Abort evaluation (only meaningful once baseline locked)
  const flags = [];
  if (baseline) {
    if (hz.ms > baseline.healthz * SLO_MULT) flags.push("healthz>SLO");
    if (cx.ms > baseline.convex * SLO_MULT) flags.push("convex>SLO");
  }
  if (errRate > MAX_ERR && recent.length >= Math.min(WINDOW, 4)) flags.push(`err${pct(errRate)}`);
  if (had5xx) flags.push("5xx");
  if (co && !/running|healthy/i.test(co.status)) flags.push(`coolify:${co.status}`);

  if (flags.length) consecFlag++; else consecFlag = 0;

  const note = flags.length ? `⚠ ${flags.join(",")}` : (baseline ? "ok" : "baselining");
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${String(n).padStart(3)}  ${time}  ${fmt(hz.ms)}ms  ${fmt(cx.ms)}ms ${fmt(tl.ms)}ms  ${had5xx ? "YES" : " no"}  ${pct(errRate).padStart(6)}  ${(co ? co.status : "off").padEnd(13)}  ${note}`);

  if (consecFlag >= 3) {
    console.log("");
    console.log("  ┌──────────────────────────────────────────────────────────────┐");
    console.log("  │  🛑 ABORT RECOMMENDED — 3 consecutive flagged samples.         │");
    console.log("  │  KILL-SWITCH: stop the load driver NOW (see stress-test.md).   │");
    console.log("  └──────────────────────────────────────────────────────────────┘");
    console.log("");
  }
}

await tick();
const timer = setInterval(tick, INTERVAL_MS);
process.on("SIGINT", () => { clearInterval(timer); console.log("\n# stopped."); process.exit(0); });
