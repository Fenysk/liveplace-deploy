#!/usr/bin/env node
/**
 * scripts/coolify-deploy.mjs — agent-only LivePlace deploy to a Coolify VPS via
 * the Coolify API (FEN-80, technical execution of FEN-79).
 *
 * One command takes the stack from "nothing on the VPS" to a green smoke:
 *
 *   load deploy.env → derive the stack env (anonymous mode by default) →
 *   create OR reuse a Docker-Compose application from a git source →
 *   push the env (build-time + runtime) → trigger instant_deploy →
 *   wait until the app is running/healthy → run scripts/smoke.mjs against
 *   the public Coolify URL → print `✅ SMOKE PASSED` (delegated to smoke.mjs).
 *
 * WHY a git source (not a raw-compose upload): docker-compose.yml BUILDS the
 * gateway/web/worker/convex-deploy images from in-repo Dockerfiles. Coolify can
 * only build those if it clones the full source tree, so the durable source is a
 * git repo Coolify pulls (build pack = dockercompose). A public repo needs no
 * deploy key — the simplest durable option. Future updates = git push + a single
 * `GET /api/v1/deploy?uuid=…` (re-run this script with COOLIFY_APP_UUID set).
 *
 * ZERO npm dependencies: Node ≥ 22 global `fetch`, `node:crypto`, `node:child_process`.
 *
 * Usage:
 *   cp infra/coolify/deploy.env.example infra/coolify/deploy.env   # fill in
 *   node scripts/coolify-deploy.mjs                # full deploy (needs a token)
 *   node scripts/coolify-deploy.mjs --dry-run      # print the plan, no network
 *   node scripts/coolify-deploy.mjs --no-smoke     # deploy but skip the smoke
 *
 * With no COOLIFY_API_TOKEN the script runs --dry-run automatically: it computes
 * and prints the exact env + API calls it WOULD make, so Phase A is verifiable
 * before the token (Phase B input) arrives.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DEPLOY_ENV_PATH = join(REPO_ROOT, "infra", "coolify", "deploy.env");

const ARGS = new Set(process.argv.slice(2));
const NO_SMOKE = ARGS.has("--no-smoke");

// HARD GUARDRAIL (Alexis, FEN-80): this script may ONLY act inside the LivePlace
// Coolify project. Every other project on that instance (Personnel, Test,
// Archives, Le Spawn, Compass, PeakSet, …) is off-limits. The target uuid is
// baked here — not just read from env — so a stray env value can never point a
// write at someone else's project. Overridable for a real project rename only
// via COOLIFY_ALLOW_PROJECT_OVERRIDE=1 (logged loudly).
const LIVEPLACE_PROJECT_UUID = "tgxjp2pout8sab9fp5edtbhb";
// Default public Coolify endpoint for this deploy (shared on FEN-80, not a secret).
const DEFAULT_COOLIFY_URL = "https://coolify.fenysk.fr";

const DEPLOY_TIMEOUT_MS = Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.COOLIFY_POLL_INTERVAL_MS ?? 8_000);

// ── tiny utils ──────────────────────────────────────────────────────────────
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`❌ coolify-deploy: ${msg}`);
  process.exit(1);
}
function gen(bytes, enc) {
  return randomBytes(bytes).toString(enc).replace(/[+/=]/g, (c) => ({ "+": "x", "/": "y", "=": "" }[c]));
}

/** Load KEY=VALUE lines from infra/coolify/deploy.env into process.env without
 *  overriding values already present in the real environment (CI/secret stores
 *  win over the file). Quotes are stripped; `#` lines and blanks are ignored. */
function loadDeployEnv() {
  if (!existsSync(DEPLOY_ENV_PATH)) {
    log(`· no ${rel(DEPLOY_ENV_PATH)} (using process env only)`);
    return;
  }
  const text = readFileSync(DEPLOY_ENV_PATH, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
  }
  log(`· loaded ${rel(DEPLOY_ENV_PATH)}`);
}
const rel = (p) => p.replace(REPO_ROOT + "/", "");

// ── config resolution ─────────────────────────────────────────────────────────
function cfg() {
  const env = process.env;
  const COOLIFY_URL = (env.COOLIFY_URL || DEFAULT_COOLIFY_URL).replace(/\/$/, "");
  // Alexis regenerated the token into COOLIFY_API_TOKEN_2 (the original
  // COOLIFY_API_TOKEN is stale). Accept either; the _2 name wins if both exist.
  const token = env.COOLIFY_API_TOKEN_2 || env.COOLIFY_API_TOKEN || "";
  const dryRun = ARGS.has("--dry-run") || !token;

  let base = env.PUBLIC_BASE_URL ?? "";
  base = base.replace(/\/$/, "");
  const host = base ? new URL(base).host : "";

  return {
    dryRun,
    COOLIFY_URL,
    token,
    projectUuid: env.COOLIFY_PROJECT_UUID || LIVEPLACE_PROJECT_UUID,
    serverUuid: env.COOLIFY_SERVER_UUID ?? "",
    environmentName: env.COOLIFY_ENVIRONMENT_NAME ?? "production",
    appName: env.COOLIFY_APP_NAME ?? "liveplace",
    appUuid: env.COOLIFY_APP_UUID ?? "",
    gitRepository: env.COOLIFY_GIT_REPOSITORY ?? "",
    gitBranch: env.COOLIFY_GIT_BRANCH ?? "main",
    composeLocation: env.COOLIFY_COMPOSE_LOCATION ?? "/docker-compose.yml",
    publicBaseUrl: base,
    host,
  };
}

/** The full stack env pushed to Coolify. Mirrors .env.example; anonymous mode by
 *  default. Random secrets are generated when blank (and flagged so the operator
 *  persists them — a regenerated secret on the next run would orphan the convex
 *  deployment / log every session out). */
function buildStackEnv(c) {
  const e = process.env;
  const generated = [];
  const need = (key, make) => {
    let v = e[key];
    if (!v) {
      v = make();
      generated.push(key);
    }
    return v;
  };

  const base = c.publicBaseUrl; // may be "" → Coolify autogenerates; filled later
  const stack = {
    // Public origins (TLS terminated at the Coolify edge; stack stays HTTP).
    PUBLIC_SITE_URL: base,
    PUBLIC_WS_URL: base ? `wss://${c.host}/ws` : "",
    SITE_ADDRESS: ":80",
    // Coolify's own proxy owns host 80/443; never republish them from our Caddy.
    PROXY_HTTP_PORT: e.PROXY_HTTP_PORT ?? "8080",
    PROXY_HTTPS_PORT: e.PROXY_HTTPS_PORT ?? "8443",

    // Auth — anonymous stack unless GATEWAY_AUTH_DISABLED=0 + Twitch creds given.
    GATEWAY_AUTH_DISABLED: e.GATEWAY_AUTH_DISABLED ?? "1",
    TWITCH_CLIENT_ID: e.TWITCH_CLIENT_ID ?? "",
    TWITCH_CLIENT_SECRET: e.TWITCH_CLIENT_SECRET ?? "",
    BETTER_AUTH_SECRET: need("BETTER_AUTH_SECRET", () => gen(32, "base64")),
    BETTER_AUTH_URL: base,

    // Convex (self-hosted). Admin key is minted by the backend (see deploy.env).
    CONVEX_SELF_HOSTED_URL: "http://convex-backend:3210",
    CONVEX_SELF_HOSTED_ADMIN_KEY: e.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "",
    CONVEX_INSTANCE_SECRET: need("CONVEX_INSTANCE_SECRET", () => gen(32, "hex")),
    VITE_CONVEX_URL: base ? `${base}/convex` : "",
    VITE_CONVEX_SITE_URL: base,

    // Redis + gateway.
    REDIS_URL: "redis://redis:6379",
    GATEWAY_PORT: "8080",
    CANVAS_WIDTH: e.CANVAS_WIDTH ?? "512",
    CANVAS_HEIGHT: e.CANVAS_HEIGHT ?? "512",
    GATEWAY_CANVAS_ID: e.GATEWAY_CANVAS_ID ?? "default",

    // F8 moderation internal seam.
    GATEWAY_INTERNAL_SECRET: need("GATEWAY_INTERNAL_SECRET", () => gen(32, "hex")),
    GATEWAY_INTERNAL_URL: "http://gateway:8080",

    // Persistence worker.
    FLUSH_INTERVAL_MS: e.FLUSH_INTERVAL_MS ?? "2000",
    FLUSH_MAX_BATCH: e.FLUSH_MAX_BATCH ?? "500",
    SNAPSHOT_INTERVAL_MS: e.SNAPSHOT_INTERVAL_MS ?? "60000",
    SNAPSHOT_EVERY_N_VERSIONS: e.SNAPSHOT_EVERY_N_VERSIONS ?? "5000",
    VIEWER_FLUSH_INTERVAL_MS: e.VIEWER_FLUSH_INTERVAL_MS ?? "10000",
    THUMBNAIL_MAX_LONG_SIDE: e.THUMBNAIL_MAX_LONG_SIDE ?? "256",
  };
  // VITE_* are inlined at image build time (docker-compose build args).
  const buildTime = new Set(["VITE_CONVEX_URL", "VITE_CONVEX_SITE_URL"]);
  return { stack, buildTime, generated };
}

// ── Coolify API ────────────────────────────────────────────────────────────────
function makeApi(c) {
  return async function api(method, path, body) {
    const url = `${c.COOLIFY_URL}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${typeof json === "object" ? JSON.stringify(json) : text}`);
    }
    return json;
  };
}

/** Enforce Alexis's hard guardrail: refuse to act outside the LivePlace project.
 *  Checks the configured uuid against the baked-in one, then confirms with the
 *  live API that the uuid actually resolves to the LivePlace project before any
 *  write happens. A mismatch aborts — we never create/modify resources in a
 *  project we did not mean to touch. */
async function assertLiveplaceProject(api, c) {
  const override = process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE === "1";
  if (c.projectUuid !== LIVEPLACE_PROJECT_UUID) {
    if (!override) {
      die(
        `GUARDRAIL: target project ${c.projectUuid} is not the LivePlace project ` +
          `(${LIVEPLACE_PROJECT_UUID}). Refusing to touch another Coolify project. ` +
          `Set COOLIFY_ALLOW_PROJECT_OVERRIDE=1 only for a deliberate project rename.`,
      );
    }
    log(`⚠ project override active: acting in ${c.projectUuid} (NOT the baked LivePlace uuid)`);
  }
  // Confirm the uuid really is the LivePlace project on this instance.
  let project;
  try {
    project = await api("GET", `/projects/${c.projectUuid}`);
  } catch (err) {
    die(`GUARDRAIL: cannot read project ${c.projectUuid} (${err.message}) — aborting before any write.`);
  }
  const name = project.name ?? project.data?.name ?? "";
  log(`· guardrail OK: project ${c.projectUuid} = "${name}"`);
  if (!override && !/liveplace/i.test(name)) {
    die(`GUARDRAIL: project ${c.projectUuid} is named "${name}", not LivePlace. Aborting.`);
  }
  return project;
}

/** Resolve the server to deploy onto. If COOLIFY_SERVER_UUID is unset, read the
 *  instance's servers; use the only one automatically, otherwise list them and
 *  ask the operator to pick — so the happy path needs no manual server lookup. */
async function resolveServerUuid(api, c) {
  if (c.serverUuid) return c.serverUuid;
  const servers = await api("GET", "/servers");
  const list = Array.isArray(servers) ? servers : servers.data ?? [];
  if (list.length === 1) {
    const uuid = list[0].uuid ?? list[0].data?.uuid;
    log(`· auto-resolved the only server: ${uuid} (${list[0].name ?? "?"})`);
    return uuid;
  }
  const opts = list.map((s) => `${s.uuid} (${s.name ?? "?"})`).join(", ");
  die(`COOLIFY_SERVER_UUID unset and ${list.length} servers found — set it to one of: ${opts}`);
}

async function resolveApp(api, c) {
  if (c.appUuid) {
    const app = await api("GET", `/applications/${c.appUuid}`);
    // Reuse path still honours the guardrail: the existing app must live in the
    // LivePlace project, else a stray COOLIFY_APP_UUID could redeploy something else.
    const appProject = app.project_uuid ?? app.environment?.project_uuid ?? app.data?.project_uuid;
    if (appProject && appProject !== c.projectUuid && process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE !== "1") {
      die(`GUARDRAIL: app ${c.appUuid} belongs to project ${appProject}, not ${c.projectUuid}. Refusing to redeploy it.`);
    }
    log(`· reusing app ${c.appUuid} (${app.name ?? c.appName})`);
    return c.appUuid;
  }
  if (!c.gitRepository) die("COOLIFY_GIT_REPOSITORY required to create the app (or set COOLIFY_APP_UUID to reuse one).");
  log(`· creating Docker-Compose app from ${c.gitRepository}@${c.gitBranch}`);
  const created = await api("POST", "/applications/public", {
    project_uuid: c.projectUuid,
    server_uuid: c.serverUuid,
    environment_name: c.environmentName,
    name: c.appName,
    git_repository: c.gitRepository,
    git_branch: c.gitBranch,
    build_pack: "dockercompose",
    docker_compose_location: c.composeLocation,
    instant_deploy: false, // env is pushed first, then we trigger the deploy
  });
  const uuid = created.uuid ?? created.application_uuid ?? created.data?.uuid;
  if (!uuid) throw new Error(`create returned no uuid: ${JSON.stringify(created)}`);
  log(`· created app ${uuid} — persist COOLIFY_APP_UUID=${uuid} for idempotent re-runs`);
  return uuid;
}

async function pushEnvs(api, uuid, stack, buildTime) {
  const data = Object.entries(stack).map(([key, value]) => ({
    key,
    value: String(value ?? ""),
    is_build_time: buildTime.has(key),
    is_preview: false,
  }));
  await api("PATCH", `/applications/${uuid}/envs/bulk`, { data });
  log(`· pushed ${data.length} env vars (${[...buildTime].join(", ")} as build args)`);
}

async function triggerDeploy(api, uuid) {
  const res = await api("GET", `/deploy?uuid=${encodeURIComponent(uuid)}&force=true`);
  log(`· deploy queued: ${JSON.stringify(res)}`);
}

async function waitHealthy(api, uuid) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < DEPLOY_TIMEOUT_MS) {
    let app;
    try {
      app = await api("GET", `/applications/${uuid}`);
    } catch (err) {
      log(`  (status poll error, retrying: ${err.message})`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = app.status ?? app.data?.status ?? "unknown";
    if (status !== last) {
      log(`  status: ${status}`);
      last = status;
    }
    // Coolify status looks like "running:healthy" / "running:unhealthy" / "exited".
    if (/running:healthy/.test(status)) return;
    if (/running\b/.test(status) && !/unhealthy|starting/.test(status)) return;
    if (/exited|error|degraded/.test(status)) throw new Error(`deployment unhealthy: ${status}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${Math.round(DEPLOY_TIMEOUT_MS / 1000)}s waiting for healthy`);
}

function runSmoke(c) {
  return new Promise((resolve, reject) => {
    if (!c.publicBaseUrl) return reject(new Error("PUBLIC_BASE_URL unknown — cannot point the smoke at the deployment"));
    const wsUrl = `wss://${c.host}/ws`;
    const child = spawn(process.execPath, [join(REPO_ROOT, "scripts", "smoke.mjs")], {
      stdio: "inherit",
      env: {
        ...process.env,
        WEB_URL: c.publicBaseUrl,
        GATEWAY_WS_URL: wsUrl,
        GATEWAY_HTTP_URL: "", // behind the proxy: only /ws is exposed
        TICKET: process.env.GATEWAY_AUTH_DISABLED === "0" ? (process.env.TICKET ?? "") : "",
      },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`smoke exited ${code}`))));
    child.on("error", reject);
  });
}

// ── orchestration ──────────────────────────────────────────────────────────────
async function main() {
  log("LivePlace → Coolify deploy");
  loadDeployEnv();
  const c = cfg();
  const { stack, buildTime, generated } = buildStackEnv(c);

  // Preflight summary (secrets redacted).
  const SECRET = /SECRET|TOKEN|ADMIN_KEY/;
  log("\n— plan —————————————————————————————————————————————");
  log(`  coolify     : ${c.COOLIFY_URL || "(unset)"}`);
  log(`  project/srv : ${c.projectUuid || "(unset)"} / ${c.serverUuid || "(unset)"} [${c.environmentName}]`);
  log(`  app         : ${c.appUuid ? `reuse ${c.appUuid}` : `create "${c.appName}"`}`);
  log(`  source      : ${c.gitRepository || "(unset)"}@${c.gitBranch} compose=${c.composeLocation}`);
  log(`  public url  : ${c.publicBaseUrl || "(autogenerate via Coolify)"}`);
  log(`  auth mode   : ${stack.GATEWAY_AUTH_DISABLED === "1" ? "ANONYMOUS (no Twitch)" : "Twitch OAuth"}`);
  log("  stack env   :");
  for (const [k, v] of Object.entries(stack)) {
    const shown = SECRET.test(k) ? (v ? "<set>" : "<empty>") : v === "" ? "(empty)" : v;
    log(`     ${buildTime.has(k) ? "[build]" : "       "} ${k}=${shown}`);
  }
  if (generated.length) log(`  generated   : ${generated.join(", ")}  ← persist these in Coolify (stable across redeploys)`);
  log("—————————————————————————————————————————————————————\n");

  // Hard checks that matter even in dry-run (catch provisioning gaps early).
  const missing = [];
  if (!c.publicBaseUrl) missing.push("PUBLIC_BASE_URL (or accept Coolify autogenerate — VITE_* build args need it)");
  if (!stack.CONVEX_SELF_HOSTED_ADMIN_KEY)
    missing.push("CONVEX_SELF_HOSTED_ADMIN_KEY (one-time: mint via `generate_admin_key.sh` in the convex-backend container)");
  // The admin key is bound to the instance secret it was minted from. If a key
  // is supplied but the secret was just auto-generated, they will not match and
  // convex-deploy auth fails — which gates the whole stack. Catch it loudly.
  if (stack.CONVEX_SELF_HOSTED_ADMIN_KEY && generated.includes("CONVEX_INSTANCE_SECRET"))
    missing.push(
      "CONVEX_INSTANCE_SECRET is blank but an admin key is set — provide the SAME secret the key was minted from " +
        "(a fresh secret would not match the key and convex-deploy would fail).",
    );
  if (missing.length) {
    log("⚠ provisioning gaps (deploy will not reach a green smoke until resolved):");
    for (const m of missing) log(`   - ${m}`);
    log("");
  }

  if (c.dryRun) {
    log(c.token ? "--dry-run: no API calls made." : "no COOLIFY_API_TOKEN → dry-run only (Phase B input pending).");
    log("API calls that WOULD run:");
    log(`   POST   /api/v1/applications/public           (build_pack=dockercompose) [unless COOLIFY_APP_UUID set]`);
    log(`   PATCH  /api/v1/applications/{uuid}/envs/bulk  (${Object.keys(stack).length} vars)`);
    log(`   GET    /api/v1/deploy?uuid={uuid}&force=true`);
    log(`   GET    /api/v1/applications/{uuid}            (poll until running:healthy)`);
    if (!NO_SMOKE) log(`   then   node scripts/smoke.mjs  (WEB_URL=${c.publicBaseUrl || "<public url>"})`);
    log("\n✅ dry-run OK — wiring is ready; supply COOLIFY_API_TOKEN (+ inputs above) to deploy.");
    return;
  }

  if (!c.COOLIFY_URL) die("COOLIFY_URL required.");
  if (!c.projectUuid) die("COOLIFY_PROJECT_UUID required.");

  const api = makeApi(c);
  // GUARDRAIL FIRST: confirm scopes + that we are pointed at LivePlace before any write.
  await assertLiveplaceProject(api, c);
  c.serverUuid = await resolveServerUuid(api, c);
  const uuid = await resolveApp(api, c);
  await pushEnvs(api, uuid, stack, buildTime);
  await triggerDeploy(api, uuid);
  log("· waiting for the stack to become healthy…");
  await waitHealthy(api, uuid);
  log("· deployment healthy.");

  if (NO_SMOKE) {
    log("--no-smoke: skipping the runtime smoke. Deploy complete.");
    return;
  }
  log("· running the WS live-pixel smoke against the deployment…");
  await runSmoke(c);
  log("\n✅ DEPLOY + SMOKE complete.");
}

main().catch((err) => die(err.message));
