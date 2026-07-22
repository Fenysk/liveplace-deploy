#!/usr/bin/env node
/**
 * scripts/mirror-push.mjs — the ONE guarded way to force-push the deploy bundle
 * to the Coolify mirror `Fenysk/liveplace-deploy.git@main`.
 *
 * WHY THIS EXISTS (FEN-1763). The design-clobber in prod recurred 3× (FEN-1580 /
 * 1625 / 1629). ADR-0007 converged the lineage and a fingerprint guard
 * (`assertDesignFingerprint` on the bundled `tokens.css`) was added — but ONLY on
 * the scripted `coolify-wire-source.mjs` path. Prod, however, is actually shipped
 * via a HAND-RUN mirror force-push (the FEN-1735/1738 reproducible path:
 * `git archive origin/main | tar -x … && rm -rf .github/workflows && git init …
 * && git push --force …liveplace-deploy.git main:main`). That raw path had NO
 * fingerprint guard, so a clobber bundle could still reach prod through it.
 *
 * This script IS that manual path, unchanged in topology (mono-commit force-push
 * to the mirror's `main`, ADR-0007) — with the SAME read-only guard bolted in
 * front of the push. It does not change how we deploy; it makes the real path
 * refuse to ship the neutral S0 layer, exactly like the scripted path already does.
 *
 * MECHANISM (identical to the documented manual path, FEN-1735/1738):
 *   1. `git archive <ref>`  (default origin/main — the served release train, C1)
 *   2. extract → strip `.github/workflows/` (PAT has no `workflow` scope)
 *   3. GUARD: assertDesignFingerprint on the extracted apps/web tokens.css
 *             + assertSafeDeployPush on the resolved remote/refspec
 *   4. fresh `git init` mono-commit → force-push to the mirror `main`
 *
 * The push step is the ONLY network write; both guards run before it. If either
 * throws, nothing is pushed.
 *
 * USAGE
 *   node scripts/mirror-push.mjs                 # build → guard → push (needs GITHUB_TOKEN)
 *   node scripts/mirror-push.mjs --dry-run       # build → guard → STOP (prints intent, no push)
 *   node scripts/mirror-push.mjs --dry-run --simulate-clobber
 *                                                # tamper tokens.css → guard MUST abort (no push)
 *   MIRROR_SOURCE_REF=HEAD node scripts/mirror-push.mjs --dry-run   # push a different ref
 *
 * ENV
 *   GITHUB_TOKEN / GH_TOKEN   PAT (repo/contents:write) — required for a real push
 *   MIRROR_REMOTE             mirror URL, default https://github.com/Fenysk/liveplace-deploy.git
 *   MIRROR_SOURCE_REF         git ref to snapshot, default origin/main
 *   MIRROR_BRANCH             mirror branch, default main
 *
 * ZERO npm deps: Node ≥ 22 + git + tar. The token is never printed and never put
 * in argv or the remote URL (one-shot GIT_ASKPASS helper).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertSafeDeployPush } from "./lib/deploy-guard.mjs";
import { assertDesignFingerprint } from "./lib/deploy-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const MIRROR_REMOTE = process.env.MIRROR_REMOTE || "https://github.com/Fenysk/liveplace-deploy.git";
const SOURCE_REF = process.env.MIRROR_SOURCE_REF || "origin/main";
const MIRROR_BRANCH = process.env.MIRROR_BRANCH || "main";
const DRY_RUN = process.argv.includes("--dry-run");
const SIMULATE_CLOBBER = process.argv.includes("--simulate-clobber");

/** tokens.css location inside the archived tree — the fingerprint source of truth. */
const TOKENS_REL = join("apps", "web", "src", "ui", "styles", "tokens.css");

const log = (m) => console.log(m);
const die = (m) => {
  console.error(`❌ mirror-push: ${m}`);
  process.exit(1);
};

const git = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) die(`git ${args.join(" ")} → ${r.status}: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout;
};

function main() {
  log(`LivePlace → guarded mirror force-push  (ADR-0007 / FEN-1763)`);
  log(`· source ref : ${SOURCE_REF}`);
  log(`· mirror     : ${MIRROR_REMOTE}  branch ${MIRROR_BRANCH}`);
  log(`· mode       : ${DRY_RUN ? (SIMULATE_CLOBBER ? "DRY-RUN + SIMULATE-CLOBBER (guard must abort)" : "DRY-RUN (guard must pass, no push)") : "LIVE PUSH"}`);

  const sourceSha = git(["rev-parse", SOURCE_REF], { cwd: REPO_ROOT }).trim();
  log(`· resolved   : ${sourceSha}`);

  // 1+2. Archive the ref into a temp tree and strip CI workflows (PAT scope, FEN-1735).
  const work = mkdtempSync(join(tmpdir(), "lp-mirror-"));
  const tarball = join(work, "src.tar");
  git(["archive", "--format=tar", "-o", tarball, sourceSha], { cwd: REPO_ROOT });
  execFileSync("tar", ["-xf", tarball, "-C", work]);
  rmSync(tarball, { force: true });
  rmSync(join(work, ".github", "workflows"), { recursive: true, force: true });

  // For the NEGATIVE verification only: deliberately clobber the extracted
  // tokens.css to the neutral S0 fingerprint so we can prove the guard blocks it —
  // WITHOUT ever pushing. Never reachable on a live push (DRY_RUN required).
  const tokensPath = join(work, TOKENS_REL);
  if (SIMULATE_CLOBBER) {
    if (!DRY_RUN) die("--simulate-clobber is a verification-only flag; it requires --dry-run (never push a clobber)");
    if (!existsSync(tokensPath)) die(`cannot simulate clobber: ${TOKENS_REL} not in the archived tree`);
    const original = readFileSync(tokensPath, "utf8");
    const clobbered = original.replace(/--elev-1:\s*[^;]+;/, "--elev-1: none;");
    writeFileSync(tokensPath, clobbered);
    log("· [simulate-clobber] rewrote extracted tokens.css → --elev-1: none (neutral S0)");
  }

  // 3. GUARDS — read-only, run BEFORE any push. Same semantics as the scripted path.
  if (!existsSync(tokensPath)) die(`design fingerprint check: expected ${TOKENS_REL} in the archived tree`);
  try {
    const value = assertDesignFingerprint(readFileSync(tokensPath, "utf8"), {
      source: `mirror bundle ${TOKENS_REL} @ ${sourceSha.slice(0, 8)}`,
    });
    log(`· design fingerprint OK — --elev-1: ${value} (neobrutalism present)`);
  } catch (e) {
    // Loud, deterministic refusal — this is the anti-clobber stop (FEN-1580).
    console.error(`\n🛑 mirror-push ABORTED — design clobber guard tripped:\n${e.message}\n`);
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }

  const refspec = `HEAD:${MIRROR_BRANCH}`;
  assertSafeDeployPush({ remoteUrl: MIRROR_REMOTE, refspec, parentless: true });
  log(`· deploy-guard OK — mirror is not the canonical trunk`);

  if (DRY_RUN) {
    log(`\n✅ DRY-RUN complete — guards passed, nothing pushed.`);
    log(`   Would force-push mono-commit of ${sourceSha.slice(0, 8)} → ${MIRROR_REMOTE} (${MIRROR_BRANCH}).`);
    rmSync(work, { recursive: true, force: true });
    return;
  }

  // 4. Mono-commit + guarded force-push (identical topology to the manual path).
  const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!TOKEN) die("no GITHUB_TOKEN (or GH_TOKEN) — required for a live mirror push. Use --dry-run to verify the guard offline.");

  const wgit = (args, opts = {}) => git(args, { cwd: work, ...opts });
  wgit(["init", "-b", MIRROR_BRANCH]);
  wgit(["config", "user.email", "noreply@paperclip.ing"]);
  wgit(["config", "user.name", "Paperclip Deploy"]);
  wgit(["add", "-A"]);
  wgit(["commit", "-m", `LivePlace deploy bundle (${sourceSha.slice(0, 8)}, FEN-1763 guarded)`]);

  const askpass = join(work, ".askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\nprintf "%s" "$GH_ASKPASS_TOKEN"\n');
  chmodSync(askpass, 0o700);
  log(`· pushing (force) → ${MIRROR_REMOTE} ${MIRROR_BRANCH} …`);
  wgit(["push", "--force", MIRROR_REMOTE, `HEAD:${MIRROR_BRANCH}`], {
    env: { ...process.env, GIT_ASKPASS: askpass, GH_ASKPASS_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: "0" },
  });

  rmSync(work, { recursive: true, force: true });
  log(`\n✅ mirror updated: ${MIRROR_REMOTE} @ ${MIRROR_BRANCH} (mono-commit of ${sourceSha.slice(0, 8)})`);
  log(`   next: GET $COOLIFY_URL/api/v1/deploy?uuid=<APP>&force=true  → poll deployment status.`);
}

main();
