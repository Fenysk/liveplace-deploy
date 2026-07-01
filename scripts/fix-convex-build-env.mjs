#!/usr/bin/env node
/**
 * scripts/fix-convex-build-env.mjs — surgical recovery for FEN-665.
 *
 * The white-page regression (FEN-617, bundle index-DimhpE-O.js shipped
 * `new ConvexReactClient("")`) was an EMPTY build-time VITE_CONVEX_URL in the
 * Coolify prod app. This script repairs ONLY that, with the smallest possible
 * blast radius:
 *
 *   1. assert the target app belongs to the LivePlace project (hard guardrail),
 *   2. read the app's REAL public fqdn (no guessing a domain),
 *   3. report the current VITE_CONVEX_URL / VITE_CONVEX_SITE_URL build values,
 *   4. PATCH *only* those two vars (is_build_time:true) to `${base}/convex` and
 *      `${base}` — every other env (Convex/auth secrets, gateway config) is left
 *      untouched, so nothing rotates,
 *   5. trigger a forced rebuild (the changed build arg busts the Docker cache),
 *   6. poll the deployment, then assert the served entry bundle inlines the URL.
 *
 * WHY NOT coolify-deploy.mjs: that re-pushes the FULL stack env and regenerates
 * any secret missing from process.env (e.g. BETTER_AUTH_SECRET) — rotating it
 * would invalidate every session / break gateway JWT verify. For a targeted
 * env fix that is the wrong tool. This script never writes a secret.
 *
 * ZERO npm deps (Node ≥ 22 global fetch). Needs a COOLIFY_API_TOKEN* in env.
 *
 * Usage:
 *   node scripts/fix-convex-build-env.mjs            # repair + redeploy + verify
 *   node scripts/fix-convex-build-env.mjs --dry-run  # inspect only, no writes
 *   COOLIFY_APP_UUID=<uuid> node scripts/fix-convex-build-env.mjs   # override target
 */

const DRY_RUN = process.argv.includes("--dry-run");
const COOLIFY_URL = (process.env.COOLIFY_URL || "https://coolify.fenysk.fr").replace(/\/$/, "");
// Baked LivePlace project guardrail (same uuid coolify-deploy.mjs bakes).
const LIVEPLACE_PROJECT_UUID = "tgxjp2pout8sab9fp5edtbhb";
// Prod LivePlace app. Overridable via COOLIFY_APP_UUID for a deliberate target.
// NOTE: do NOT read infra/coolify/deploy.env here — its COOLIFY_APP_UUID is a
// stale sslip.io provisioning artifact, not prod (FEN-665 investigation).
const PROD_APP_UUID = process.env.COOLIFY_APP_UUID || "ydt5ysqbmk9tglqwv88lgdy0";
const DEPLOY_TIMEOUT_MS = Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.COOLIFY_POLL_INTERVAL_MS ?? 8_000);

const log = (m) => console.log(m);
const die = (m) => {
  console.error(`❌ ${m}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveToken(env) {
  let best = null;
  let bestN = -1;
  for (const [k, v] of Object.entries(env)) {
    const m = /^COOLIFY_API_TOKEN(?:_(\d+))?$/.exec(k);
    if (m && v) {
      const n = m[1] ? Number(m[1]) : 0;
      if (n > bestN) {
        bestN = n;
        best = v;
      }
    }
  }
  return best;
}

// Coolify uses Laravel Sanctum, whose tokens are `id|plaintext` and MUST be sent
// WHOLE (the proven coolify-deploy.mjs never strips, and ~30 deploys worked that
// way). But some rotations may store the raw plaintext only. We can't know which
// form a given secret is in and a wrong guess is a 401 that burns a token window,
// so we try the value AS-STORED first, then the prefix-stripped form on a 401.
const RAW_TOKEN = resolveToken(process.env);
const TOKEN_CANDIDATES = RAW_TOKEN
  ? [...new Set([RAW_TOKEN, RAW_TOKEN.replace(/^\d+\|/, "")])]
  : [];
let TOKEN = TOKEN_CANDIDATES[0] ?? null;

async function api(method, path, body) {
  const attempt = async (tok) =>
    fetch(`${COOLIFY_URL}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res = await attempt(TOKEN);
  // On a 401/403, the stored token form was wrong — fall back to the alternate
  // candidate and PIN it for the rest of the run so we don't retry every call.
  if ((res.status === 401 || res.status === 403) && TOKEN_CANDIDATES[1] && TOKEN !== TOKEN_CANDIDATES[1]) {
    log(`· auth ${res.status} with primary token form — retrying with the alternate (prefix-stripped) form.`);
    TOKEN = TOKEN_CANDIDATES[1];
    res = await attempt(TOKEN);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof json === "object" ? JSON.stringify(json) : text}`);
  return json;
}

async function verifyServedBundle(base, expected) {
  const root = base.replace(/\/$/, "");
  const html = await (await fetch(`${root}/`)).text();
  const m = html.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/i);
  if (!m) throw new Error(`no entry /assets/index-*.js in served HTML at ${root}/`);
  const entry = m[1].startsWith("http") ? m[1] : `${root}${m[1].startsWith("/") ? "" : "/"}${m[1]}`;
  const js = await (await fetch(entry)).text();
  const ok = js.includes(JSON.stringify(expected)) || js.includes(expected);
  return { entry, ok };
}

async function main() {
  log(`FEN-665 recovery → ${COOLIFY_URL}  app=${PROD_APP_UUID}${DRY_RUN ? "  [DRY-RUN]" : ""}`);
  if (!TOKEN) die("no COOLIFY_API_TOKEN* in env — cannot reach the Coolify API.");

  // 1. Guardrail + read the real fqdn.
  const app = await api("GET", `/applications/${PROD_APP_UUID}`);
  const a = app.data ?? app;
  const projectUuid =
    a.environment?.project?.uuid ?? a.project_uuid ?? a.destination?.environment?.project?.uuid ?? "";
  if (projectUuid && projectUuid !== LIVEPLACE_PROJECT_UUID && process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE !== "1") {
    die(
      `GUARDRAIL: app ${PROD_APP_UUID} resolves to project ${projectUuid}, not LivePlace ` +
        `(${LIVEPLACE_PROJECT_UUID}). Refusing to touch another project.`,
    );
  }
  // Docker-Compose apps store the domain in docker_compose_domains, not fqdn.
  // Fallback order: fqdn field → docker_compose_domains → PUBLIC_BASE_URL env override.
  let fqdn = String(a.fqdn ?? "").split(",")[0].trim().replace(/\/$/, "");
  if (!fqdn || !/^https?:\/\//i.test(fqdn)) {
    try {
      const dcDomains = typeof a.docker_compose_domains === "string"
        ? JSON.parse(a.docker_compose_domains)
        : a.docker_compose_domains;
      if (dcDomains) {
        const firstSvc = Object.values(dcDomains)[0];
        const candidate = firstSvc?.domain ?? firstSvc?.domains?.[0] ?? "";
        if (/^https?:\/\//i.test(String(candidate))) fqdn = String(candidate).replace(/\/$/, "");
      }
    } catch (_) { /* json parse failure — fall through */ }
  }
  if ((!fqdn || !/^https?:\/\//i.test(fqdn)) && process.env.PUBLIC_BASE_URL) {
    fqdn = process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
    log(`· fqdn not in API response — using PUBLIC_BASE_URL override: ${fqdn}`);
  }
  if (!/^https?:\/\/.+/i.test(fqdn)) die(`app fqdn is "${fqdn}" — cannot derive an absolute Convex URL. Set the app domain in Coolify first.`);
  const desired = { VITE_CONVEX_URL: `${fqdn}/convex`, VITE_CONVEX_SITE_URL: fqdn };
  log(`· app fqdn: ${fqdn}  → VITE_CONVEX_URL=${desired.VITE_CONVEX_URL}`);

  // 2. Report current build-time values (empirical root-cause confirmation).
  const envs = await api("GET", `/applications/${PROD_APP_UUID}/envs`);
  const list = Array.isArray(envs) ? envs : (envs.data ?? []);
  for (const k of Object.keys(desired)) {
    const cur = list.find((e) => (e.key ?? e.data?.key) === k);
    const v = cur ? (cur.value ?? cur.data?.value ?? "") : "(absent)";
    const bt = cur ? (cur.is_build_time ?? cur.data?.is_build_time) : "—";
    log(`· current ${k} = ${v === "" ? "(EMPTY ← root cause)" : `"${v}"`}  [build_time=${bt}]`);
  }

  if (DRY_RUN) {
    log("\n--dry-run: would PATCH the two VITE_* build vars + force a rebuild. No writes made.");
    return;
  }

  // 3. Surgical upsert: only the two build vars, build-time. Nothing else touched.
  await api("PATCH", `/applications/${PROD_APP_UUID}/envs/bulk`, {
    data: Object.entries(desired).map(([key, value]) => ({ key, value, is_build_time: true, is_preview: false })),
  });
  log("· patched VITE_CONVEX_URL + VITE_CONVEX_SITE_URL (build-time). All other envs untouched.");

  // 4. Forced rebuild — the changed build arg busts the Docker cache layer.
  const dep = await api("GET", `/deploy?uuid=${encodeURIComponent(PROD_APP_UUID)}&force=true`);
  const depUuid = dep.deployments?.[0]?.deployment_uuid ?? dep.deployment_uuid ?? null;
  log(`· rebuild queued${depUuid ? ` (deployment ${depUuid})` : ""}.`);

  // 5. Poll to a terminal state.
  if (depUuid) {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < DEPLOY_TIMEOUT_MS) {
      let d;
      try {
        d = await api("GET", `/deployments/${depUuid}`);
      } catch (err) {
        log(`  (poll retry: ${err.message})`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const status = d.status ?? d.data?.status ?? "unknown";
      if (status !== last) {
        log(`  build: ${status}`);
        last = status;
      }
      if (/finished|success|completed/i.test(status)) break;
      if (/failed|error|cancelled/i.test(status)) die(`build ${status} — check Coolify logs for ${depUuid}.`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // 6. Verify the SERVED bundle now inlines the URL (the real proof React mounts).
  await sleep(POLL_INTERVAL_MS);
  const { entry, ok } = await verifyServedBundle(fqdn, desired.VITE_CONVEX_URL).catch((e) => ({ entry: e.message, ok: false }));
  if (!ok) die(`served bundle still does NOT inline ${desired.VITE_CONVEX_URL} (entry: ${entry}). Build may still be propagating — re-run --dry-run to inspect.`);
  log(`\n✅ FEN-665 fixed: served entry ${entry.split("/").pop()} inlines VITE_CONVEX_URL=${desired.VITE_CONVEX_URL}.`);
  log(`   Next: smoke EXPECT_CONVEX_URL=${desired.VITE_CONVEX_URL} WEB_URL=${fqdn} GATEWAY_HTTP_URL= GATEWAY_WS_URL=wss://${new URL(fqdn).host}/ws node scripts/smoke.mjs`);
}

main().catch((err) => die(err.message));
