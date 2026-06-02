#!/usr/bin/env node
/**
 * scripts/make-deploy-bundle.mjs — produce the self-contained source artifact
 * Coolify will build from (FEN-80 Phase A).
 *
 * Coolify deploys our stack by CLONING a git repo and running the dockercompose
 * build pack, so the "bundle" is exactly the set of git-tracked files —
 * `git archive` gives that, honouring .gitignore (no node_modules, no .env, no
 * secrets, no .git history). Seed any git host Coolify can reach from this:
 *
 *   node scripts/make-deploy-bundle.mjs
 *   # → dist/liveplace-deploy.tar.gz  +  a printed file/secret/build sanity report
 *
 * To publish to a fresh public repo (one-time provisioning, needs git creds):
 *   mkdir /tmp/lp && tar -xzf dist/liveplace-deploy.tar.gz -C /tmp/lp
 *   cd /tmp/lp && git init -b main && git add -A && git commit -m "LivePlace deploy bundle"
 *   git remote add origin <public-repo-url> && git push -u origin main
 *
 * ZERO npm deps: Node ≥ 22 + git.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUT_DIR = join(REPO_ROOT, "dist");
const OUT = join(OUT_DIR, "liveplace-deploy.tar.gz");

const git = (...a) => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" });
const fail = (m) => {
  console.error(`❌ make-deploy-bundle: ${m}`);
  process.exit(1);
};

// Files Coolify MUST see to build the compose stack.
const REQUIRED = [
  "docker-compose.yml",
  ".dockerignore",
  "apps/gateway/Dockerfile",
  "apps/web/Dockerfile",
  "apps/worker/Dockerfile",
  "apps/convex/Dockerfile",
  "apps/convex/deploy.sh",
  "infra/Caddyfile",
  "pnpm-lock.yaml",
];
// A real secret must NEVER enter the bundle. (.env.example / *.example are fine.)
const SECRET_RE = /(^|\/)\.env$|(^|\/)\.env\.[^.]*$|deploy\.env$|\.pem$|id_rsa/;

const tracked = git("ls-files").split("\n").filter(Boolean);
console.log(`· ${tracked.length} git-tracked files in scope`);

const leaked = tracked.filter((f) => SECRET_RE.test(f) && !/\.example$/.test(f));
if (leaked.length) fail(`secret-looking files are tracked and would ship: ${leaked.join(", ")}`);
console.log("· no secret files in the tracked set ✓");

const trackedSet = new Set(tracked);
const missing = REQUIRED.filter((f) => !trackedSet.has(f));
if (missing.length) fail(`required build files not tracked: ${missing.join(", ")}`);
console.log(`· all ${REQUIRED.length} required build files present ✓`);

mkdirSync(OUT_DIR, { recursive: true });
git("archive", "--format=tar.gz", "-o", OUT, "HEAD");
const bytes = statSync(OUT).size;
const head = git("rev-parse", "--short", "HEAD").trim();

console.log(`\n✅ bundle: ${OUT.replace(REPO_ROOT + "/", "")}  (${(bytes / 1024).toFixed(0)} KiB, HEAD ${head})`);
console.log("   This is exactly what Coolify clones + builds (build pack = dockercompose).");
console.log("   Point COOLIFY_GIT_REPOSITORY at the git host you seed from it.");
