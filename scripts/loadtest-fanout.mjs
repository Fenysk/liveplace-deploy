#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/loadtest-fanout.mjs — generate the MULTI-CANVAS load-test stack (FEN-516).
//
//   ⚠️  STILL NEVER PRODUCTION. Emits a self-contained, disposable compose project
//       (`liveplace-loadtest-fanout`) that is byte-isolated from prod exactly like
//       the single-canvas stack (FEN-511): own project name → own namespaced
//       volumes/network, reads ONLY `.env.loadtest`, no `web`/`proxy`/TLS.
//
// WHY THIS EXISTS
//   docker-compose.loadtest.yml (FEN-511) ships ONE gateway + ONE worker, both
//   pinned to a SINGLE canvas via GATEWAY_CANVAS_ID. The gateway resolves its
//   canvas from that env, NOT from the WS path (apps/gateway/src/config.ts), and
//   the worker drains exactly one `canvas:{slug}:stream` (apps/worker/src/index.ts
//   — "Single-canvas MVP: one slug, one drain loop"). So the graven 20-toiles ×
//   500 = 10 000 conns target CANNOT be driven as 20 distinct canvases from that
//   stack: the default run is a MONO-CANVAS ceiling (Redis sees one stream, one
//   worker drains it — a harder broadcast test, but no multi-canvas distribution
//   and no worker-drain parallelism).
//
//   `docker compose --scale gateway=N` does NOT solve it: replicas share identical
//   config, so all N land on the SAME canvas and cannot each publish a distinct
//   host port. A faithful 20-canvas run therefore needs N DISTINCT gateway AND
//   worker services, each with its own GATEWAY_CANVAS_ID=loadtest-<i> and (for the
//   gateway) its own host port. This generator emits exactly that — pure compose
//   orchestration, NO app-code change (the stack is owned by Alexis).
//
// WHAT IT EMITS (idempotent, deterministic from N + base port)
//   • docker-compose.loadtest.fanout.yml — standalone project with the SHARED
//       backend (redis, convex-backend, convex-admin-key, convex-deploy) + N
//       gateway-<i> + N worker-<i>, each canvas = loadtest-<i>.
//   • .env.loadtest-fanout-targets — TARGET_URLS=ws://localhost:<port>,… for the
//       campaign runner (FEN-512). Also printed to stdout.
//
// USAGE (or via ./scripts/loadtest.sh fanout-gen):
//   node scripts/loadtest-fanout.mjs [--canvases N] [--base-port P]
//     --canvases N   number of distinct canvases/gateways/workers (default 20)
//     --base-port P  host port of gateway-0; gateway-<i> → P+i (default 8100)
//
// This file is the SOURCE OF TRUTH. The emitted compose file is a generated
// artifact — regenerate it, do not hand-edit. If the SHARED backend services in
// docker-compose.loadtest.yml change, mirror the change in the BACKEND template
// below and regenerate. See docs/runbooks/loadtest-env.md.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { canvases: 20, basePort: 8100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--canvases" || a === "-n") out.canvases = Number(argv[++i]);
    else if (a === "--base-port" || a === "-p") out.basePort = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("usage: loadtest-fanout.mjs [--canvases N] [--base-port P]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.canvases) || out.canvases < 1 || out.canvases > 200) {
    console.error(`--canvases must be an integer in [1,200], got ${out.canvases}`);
    process.exit(2);
  }
  if (!Number.isInteger(out.basePort) || out.basePort < 1024 || out.basePort + out.canvases > 65535) {
    console.error(`--base-port invalid or port range overflows 65535 (base ${out.basePort} + ${out.canvases})`);
    process.exit(2);
  }
  return out;
}

const { canvases, basePort } = parseArgs(process.argv.slice(2));

// ---- SHARED backend (mirrors docker-compose.loadtest.yml; regenerate on change)
// One Redis + one Convex backend serve ALL canvases: each canvas is a distinct
// `loadtest-<i>` slug → distinct `canvas:{slug}:stream` in the SAME Redis, and a
// distinct row in the SAME (free, self-hosted) Convex. That is what gives genuine
// multi-canvas stream distribution + per-canvas worker-drain parallelism.
const BACKEND = `  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  convex-backend:
    image: ghcr.io/get-convex/convex-backend:latest
    env_file: [.env.loadtest]
    environment:
      - INSTANCE_NAME=liveplace-loadtest
      - INSTANCE_SECRET=\${CONVEX_INSTANCE_SECRET}
      - CONVEX_CLOUD_ORIGIN=http://localhost:3210
      - CONVEX_SITE_ORIGIN=http://localhost:3211
    volumes:
      - convex-data-2:/convex/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3210/version"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    restart: unless-stopped

  convex-admin-key:
    build:
      context: .
      dockerfile: infra/convex-admin-key/Dockerfile
    env_file: [.env.loadtest]
    environment:
      - INSTANCE_NAME=liveplace-loadtest
      - INSTANCE_SECRET=\${CONVEX_INSTANCE_SECRET}
    volumes:
      - convex-admin:/admin
    depends_on:
      convex-backend:
        condition: service_healthy
    restart: "no"

  convex-deploy:
    build:
      context: .
      dockerfile: apps/convex/Dockerfile
    env_file: [.env.loadtest]
    environment:
      - CONVEX_SELF_HOSTED_URL=http://convex-backend:3210
    volumes:
      - convex-admin:/admin:ro
    depends_on:
      convex-backend:
        condition: service_healthy
      convex-admin-key:
        condition: service_started
    restart: "no"`;

// ---- per-canvas gateway + worker templates ----------------------------------
// All gateway-<i> share ONE image tag (`build:` runs once, reused) so 20 gateways
// don't rebuild the same context 20×. Same for workers. GATEWAY_CANVAS_ID in
// `environment` overrides the `.env.loadtest` default (loadtest-default), pinning
// each service to its own canvas. The gateway publishes a distinct host port so
// the driver can open ~500 sockets per canvas against the raw WS hot path.
function gatewayService(i, port) {
  return `  gateway-${i}:
    image: liveplace-loadtest-fanout/gateway
    build:
      context: .
      dockerfile: apps/gateway/Dockerfile
    env_file: [.env.loadtest]
    environment:
      - REDIS_URL=redis://redis:6379
      - GATEWAY_CANVAS_ID=loadtest-${i}
      - GATEWAY_INTERNAL_SECRET=\${GATEWAY_INTERNAL_SECRET:-}
      - CONVEX_JWKS_URL=http://convex-backend:3211/api/auth/convex/jwks
      - GATEWAY_JWT_AUDIENCE=convex
    ports:
      - "${port}:8080"
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 10s
    restart: unless-stopped`;
}

function workerService(i) {
  return `  worker-${i}:
    image: liveplace-loadtest-fanout/worker
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    env_file: [.env.loadtest]
    environment:
      - REDIS_URL=redis://redis:6379
      - CONVEX_SELF_HOSTED_URL=http://convex-backend:3210
      - GATEWAY_CANVAS_ID=loadtest-${i}
      - GATEWAY_INTERNAL_SECRET=\${GATEWAY_INTERNAL_SECRET:-}
    depends_on:
      redis:
        condition: service_healthy
      convex-backend:
        condition: service_healthy
    restart: unless-stopped`;
}

// ---- assemble compose file --------------------------------------------------
const ports = Array.from({ length: canvases }, (_, i) => basePort + i);
const gateways = ports.map((p, i) => gatewayService(i, p));
const workers = ports.map((_, i) => workerService(i));

const header = `# ─────────────────────────────────────────────────────────────────────────────
# GENERATED by scripts/loadtest-fanout.mjs — DO NOT HAND-EDIT (regenerate instead).
#   N=${canvases} canvases · gateway-<i> host ports ${basePort}..${basePort + canvases - 1} · canvas loadtest-<i>
#
# MULTI-CANVAS disposable load-test stack (FEN-516). Drives the graven
# 20-toiles × 500 = 10 000 conns target as N GENUINELY DISTINCT canvases — each
# with its own gateway (own host port) AND its own worker drain loop — over ONE
# shared, disposable Redis + Convex backend. This is the multi-canvas counterpart
# to the single-canvas docker-compose.loadtest.yml (which is a mono-canvas
# ceiling). NEVER PRODUCTION: own project name, namespaced volumes, .env.loadtest
# only, no web/proxy/TLS. See docs/runbooks/loadtest-env.md.
#
# Bring up:  ./scripts/loadtest.sh fanout-up
# Targets:   .env.loadtest-fanout-targets  (TARGET_URLS for the campaign runner)
# ─────────────────────────────────────────────────────────────────────────────
name: liveplace-loadtest-fanout

services:
`;

const volumes = `
volumes:
  # DISPOSABLE — \`down -v\` (./scripts/loadtest.sh fanout-clean) removes them.
  redis-data:
  convex-data-2:
  convex-admin:
`;

const compose =
  header +
  BACKEND +
  "\n\n" +
  gateways.join("\n\n") +
  "\n\n" +
  workers.join("\n\n") +
  "\n" +
  volumes;

const composePath = join(REPO_ROOT, "docker-compose.loadtest.fanout.yml");
writeFileSync(composePath, compose);

// ---- TARGET_URLS for the campaign runner (FEN-512) --------------------------
const targetUrls = ports.map((p) => `ws://localhost:${p}`).join(",");
const targetsBody = `# GENERATED by scripts/loadtest-fanout.mjs — N=${canvases} canvases, base port ${basePort}.
# Feed these into the load-campaign runner (FEN-512): \`source\` this file, then use
# $TARGET_URLS. Each URL is one gateway pinned to canvas loadtest-<i>. Drive ~500
# sockets per URL for the 20×500 = 10 000 conns target.
TARGET_URLS=${targetUrls}
`;
const targetsPath = join(REPO_ROOT, ".env.loadtest-fanout-targets");
writeFileSync(targetsPath, targetsBody);

// ---- report -----------------------------------------------------------------
console.log(`✓ wrote ${composePath}`);
console.log(`    ${canvases} canvases · ${canvases} gateways · ${canvases} workers · 1 shared Redis + Convex`);
console.log(`    gateway host ports: ${basePort}..${basePort + canvases - 1}`);
console.log(`✓ wrote ${targetsPath}`);
console.log(`TARGET_URLS=${targetUrls}`);
