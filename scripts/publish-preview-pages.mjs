#!/usr/bin/env node
/**
 * scripts/publish-preview-pages.mjs — reproducible publish of the UI maquettes
 * preview to the ALWAYS-ON GitHub Pages site (FEN-195 rail, used by FEN-204).
 *
 * Replaces the earlier ad-hoc token-paste publish (a snowflake) with one
 * committed, idempotent command. Any agent with a GITHUB_TOKEN can run it:
 *
 *   build the maquettes  →  point this at the built dist  →  it mirrors the dist
 *   into a fresh clone of the dedicated Pages repo, adds the SPA 404.html
 *   fallback + .nojekyll, commits and pushes → GitHub Pages serves the update.
 *
 * Live URL:   https://fenysk.github.io/liveplace-ui-preview/
 * Pages repo: Fenysk/liveplace-ui-preview   (dedicated, public, 24/7)
 *
 * CRITICAL — base path: GitHub Pages serves this as a PROJECT site under the
 * sub-path `/liveplace-ui-preview/`. For client-side deep-links to load their
 * assets, the maquettes MUST be built with Vite `base: '/liveplace-ui-preview/'`
 * (absolute), NOT the relative `./` "preview local" build. This script does not
 * build — it LINTS index.html and refuses to publish a relative-base build that
 * would break deep-links on Pages (override with --allow-relative-base if you
 * really only want the entry page to work).
 *
 * SECRETS: GITHUB_TOKEN is read from the env (or infra/coolify/deploy.env) and
 * never written to the repo. The token is injected into the push URL in-memory
 * only.
 *
 * ZERO npm dependencies: Node >= 20 (node:fs, node:os, node:path, node:child_process).
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish-preview-pages.mjs [DIST_DIR]
 *
 *   DIST_DIR defaults to ./preview/site (the built maquettes output).
 *
 * Env overrides:
 *   PREVIEW_PAGES_REPO    owner/repo of the Pages repo (default Fenysk/liveplace-ui-preview)
 *   PREVIEW_PAGES_BRANCH  branch Pages serves from   (default main)
 *   PREVIEW_DIST          alternative to the positional DIST_DIR arg
 *   GITHUB_TOKEN          required to push (a token with `repo` scope on the Pages repo)
 *
 * Flags:
 *   --dry-run               assemble + lint, print the plan, do NOT push
 *   --allow-relative-base   publish even if index.html uses a relative asset base
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, cpSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

function arg(name) {
  return process.argv.includes(name);
}
function loadDeployEnvToken() {
  // Best-effort: pull GITHUB_TOKEN out of the gitignored infra/coolify/deploy.env
  // if it is not already in the process env. Never logged.
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const f = join(REPO_ROOT, "infra/coolify/deploy.env");
  if (!existsSync(f)) return "";
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*GITHUB_TOKEN\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return "";
}

const DRY_RUN = arg("--dry-run");
const ALLOW_RELATIVE = arg("--allow-relative-base");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DIST = resolve(positional[0] || process.env.PREVIEW_DIST || join(REPO_ROOT, "preview/site"));
const PAGES_REPO = process.env.PREVIEW_PAGES_REPO || "Fenysk/liveplace-ui-preview";
const PAGES_BRANCH = process.env.PREVIEW_PAGES_BRANCH || "main";
const TOKEN = loadDeployEnvToken();

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
}

// --- 1. validate the built dist ----------------------------------------------
if (!existsSync(DIST)) die(`dist dir not found: ${DIST} (build the maquettes first)`);
const indexHtml = join(DIST, "index.html");
if (!existsSync(indexHtml)) die(`no index.html in ${DIST}`);

const html = readFileSync(indexHtml, "utf8");
const usesRelativeBase = /\b(?:src|href)=["']\.\/assets\//.test(html);
const usesPagesBase = html.includes(`/${PAGES_REPO.split("/")[1]}/assets/`);
console.log(`• dist:        ${DIST}`);
console.log(`• pages repo:  ${PAGES_REPO} (branch ${PAGES_BRANCH})`);
console.log(`• base check:  ${usesPagesBase ? "absolute /<repo>/ ✓" : usesRelativeBase ? "RELATIVE ./assets ⚠" : "unknown"}`);

if (usesRelativeBase && !usesPagesBase && !ALLOW_RELATIVE) {
  die(
    `index.html uses a RELATIVE asset base (./assets). On GitHub Pages this only\n` +
      `  works for the entry page — client-side deep-links will 404 their assets.\n` +
      `  Rebuild the maquettes with Vite base '/${PAGES_REPO.split("/")[1]}/', e.g.\n` +
      `    vite build --base=/${PAGES_REPO.split("/")[1]}/\n` +
      `  or re-run with --allow-relative-base to publish anyway.`,
  );
}

// --- 2. assemble the publish tree in a temp clone ----------------------------
if (!TOKEN && !DRY_RUN) die("GITHUB_TOKEN not set (env or infra/coolify/deploy.env) — cannot push. Use --dry-run to assemble only.");

const work = mkdtempSync(join(tmpdir(), "lp-preview-"));
const cloneDir = join(work, "pages");
const cloneUrl = TOKEN
  ? `https://x-access-token:${TOKEN}@github.com/${PAGES_REPO}.git`
  : `https://github.com/${PAGES_REPO}.git`;

try {
  if (DRY_RUN && !TOKEN) {
    // No token: just stage into a scratch dir so we can prove the assembly.
    cpSync(DIST, cloneDir, { recursive: true });
  } else {
    console.log(`• cloning ${PAGES_REPO} …`);
    sh("git", ["clone", "--depth", "1", "--branch", PAGES_BRANCH, cloneUrl, cloneDir]);
    // wipe tracked content (keep .git) then mirror the fresh dist in
    for (const entry of sh("git", ["-C", cloneDir, "ls-files"]).split("\n").filter(Boolean)) {
      rmSync(join(cloneDir, entry), { force: true });
    }
    cpSync(DIST, cloneDir, { recursive: true });
  }

  // SPA deep-link fallback: GitHub Pages serves 404.html for unmatched paths.
  copyFileSync(join(cloneDir, "index.html"), join(cloneDir, "404.html"));
  // Disable Jekyll so files/dirs starting with `_` are served verbatim.
  writeFileSync(join(cloneDir, ".nojekyll"), "");

  console.log(`• assembled publish tree (index.html + 404.html SPA fallback + .nojekyll)`);

  if (DRY_RUN) {
    console.log(`\n✅ DRY RUN — assembled at ${cloneDir}, nothing pushed.`);
    process.exit(0);
  }

  // --- 3. commit + push ------------------------------------------------------
  sh("git", ["-C", cloneDir, "config", "user.name", "LivePlace DevOps"]);
  sh("git", ["-C", cloneDir, "config", "user.email", "noreply@paperclip.ing"]);
  sh("git", ["-C", cloneDir, "add", "-A"]);
  const status = sh("git", ["-C", cloneDir, "status", "--porcelain"]).trim();
  if (!status) {
    console.log(`\n✅ Pages already up to date — nothing to publish.`);
    process.exit(0);
  }
  sh("git", ["-C", cloneDir, "commit", "-m", "chore(preview): republish UI maquettes (FEN-204)"]);
  sh("git", ["-C", cloneDir, "push", "origin", PAGES_BRANCH]);
  console.log(`\n✅ PUBLISHED → https://${PAGES_REPO.split("/")[0].toLowerCase()}.github.io/${PAGES_REPO.split("/")[1]}/`);
  console.log(`   (GitHub Pages may take ~30–60s to serve the new build)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
