#!/usr/bin/env node
/**
 * scripts/lib/deploy-guard.mjs — make the FEN-179 severed-trunk hazard unrepeatable.
 *
 * The deploy bundle is a PARENTLESS, secret-free `git init` snapshot (see
 * make-deploy-bundle.mjs / coolify-wire-source.mjs). Coolify builds by cloning a
 * git host, so we force-push that flat snapshot to a deploy ref. The hazard
 * (FEN-172 → FEN-179): that flat snapshot landed on the **canonical** shared
 * remote `liveplace.git` `main`, severing the 118-commit trunk and dropping
 * FEN-160 off deployed `main`.
 *
 * Safety invariant enforced here — a deploy snapshot may push ONLY to:
 *   (a) the dedicated public deploy repo  (any remote whose basename is NOT the
 *       canonical `liveplace.git`), on any branch, OR
 *   (b) the `deploy/*` ref namespace on ANY remote (incl. canonical).
 * Everything else — above all `liveplace.git:main` / `:master` / any feature
 * branch on canonical — is REFUSED, loudly, before git runs.
 *
 * Convention: see docs/adr/0005-deploy-snapshot-vs-canonical-trunk.md.
 *   canonical `liveplace.git` main = development trunk (real, contiguous history).
 *   deploy artifact = parentless snapshot on the deploy repo and/or `deploy/*` ref.
 *
 * ZERO npm deps. Self-test: `node scripts/lib/deploy-guard.mjs --selftest`.
 */

/** Repos whose `main` carries real, contiguous history and must never be flattened. */
export const CANONICAL_BASENAMES = new Set(["liveplace.git", "liveplace"]);

/** Ref namespace reserved for parentless deploy snapshots. */
export const DEPLOY_REF_PREFIX = "deploy/";

export class DeployGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeployGuardError";
  }
}

/**
 * Last path segment of a git remote URL, stripped of auth/query/trailing slash.
 *   https://x-access-token@github.com/Fenysk/liveplace-deploy.git → "liveplace-deploy.git"
 *   /paperclip/.../fen-35/liveplace.git                          → "liveplace.git"
 *   git@github.com:Fenysk/liveplace.git                          → "liveplace.git"
 */
export function remoteBasename(url) {
  if (!url) return "";
  let s = String(url).trim();
  s = s.replace(/[#?].*$/, ""); // drop query/fragment
  s = s.replace(/\/+$/, ""); // drop trailing slashes
  // scp-style `git@host:owner/repo.git` → take after last "/" or ":"
  const seg = s.split(/[/:]/).pop() || "";
  return seg.toLowerCase();
}

export function isCanonicalRemote(url) {
  return CANONICAL_BASENAMES.has(remoteBasename(url));
}

/**
 * Destination branch of a git refspec.
 *   "HEAD:main"               → "main"
 *   "+refs/heads/x:refs/heads/main" → "main"
 *   "deploy/liveplace-fen172" → "deploy/liveplace-fen172"
 */
export function destBranch(refspec) {
  let s = String(refspec || "").trim().replace(/^\+/, "");
  const dst = s.includes(":") ? s.split(":").pop() : s;
  return dst.replace(/^refs\/heads\//, "");
}

export function isDeployRef(refspec) {
  return destBranch(refspec).startsWith(DEPLOY_REF_PREFIX);
}

/**
 * Throw DeployGuardError if pushing `refspec` to `remoteUrl` would (or could)
 * overwrite a canonical trunk with a flat deploy snapshot. Call this immediately
 * before any `git push` in the bundle/deploy path. `parentless` is informational
 * (the bundle is always parentless) and only sharpens the error message.
 */
export function assertSafeDeployPush({ remoteUrl, refspec, parentless = true } = {}) {
  if (!remoteUrl) throw new DeployGuardError("deploy-guard: empty remoteUrl — refusing push");
  if (!refspec) throw new DeployGuardError("deploy-guard: empty refspec — refusing push");

  const canonical = isCanonicalRemote(remoteUrl);
  const onDeployRef = isDeployRef(refspec);
  if (!canonical || onDeployRef) return; // allowed

  const branch = destBranch(refspec);
  throw new DeployGuardError(
    [
      "",
      "🛑 deploy-guard: REFUSING to push a deploy snapshot to the CANONICAL repo.",
      `   remote : ${remoteUrl}  (basename "${remoteBasename(remoteUrl)}" = canonical trunk)`,
      `   refspec: ${refspec}  → branch "${branch}"`,
      parentless ? "   commit : PARENTLESS snapshot — would sever the contiguous trunk." : "",
      "",
      "   This is exactly the FEN-179 severed-trunk hazard. A flat deploy snapshot",
      "   may push ONLY to the dedicated deploy repo, or to a `deploy/*` ref.",
      "   Fix: target the public deploy repo (the `gh` remote), or rename the ref to",
      `   "${DEPLOY_REF_PREFIX}<name>". Canonical "${branch}" is the development trunk — never deploy onto it.`,
      "   See docs/adr/0005-deploy-snapshot-vs-canonical-trunk.md.",
      "",
    ].join("\n"),
  );
}

/* ------------------------------- self-test -------------------------------- */
function selftest() {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond) => {
    if (cond) {
      pass++;
    } else {
      fail++;
      console.error(`  ✗ ${name}`);
    }
  };
  const rejects = (args) => {
    try {
      assertSafeDeployPush(args);
      return false;
    } catch (e) {
      return e instanceof DeployGuardError;
    }
  };
  const allows = (args) => {
    try {
      assertSafeDeployPush(args);
      return true;
    } catch {
      return false;
    }
  };

  const CANON = "/paperclip/.../fen-35/liveplace.git";
  const DEPLOY = "https://x-access-token@github.com/Fenysk/liveplace-deploy.git";

  // The exact FEN-179 hazard must be rejected.
  ok("reject canonical:main (HEAD:main)", rejects({ remoteUrl: CANON, refspec: "HEAD:main" }));
  ok("reject canonical:main (plain)", rejects({ remoteUrl: CANON, refspec: "main" }));
  ok("reject canonical:master", rejects({ remoteUrl: CANON, refspec: "master" }));
  ok("reject canonical:feature", rejects({ remoteUrl: CANON, refspec: "fen-160-crisis" }));
  ok("reject canonical refs/heads/main", rejects({ remoteUrl: CANON, refspec: "+refs/heads/x:refs/heads/main" }));
  ok("reject scp-style canonical", rejects({ remoteUrl: "git@github.com:Fenysk/liveplace.git", refspec: "HEAD:main" }));

  // Legitimate deploy paths must be allowed.
  ok("allow deploy repo main", allows({ remoteUrl: DEPLOY, refspec: "HEAD:main" }));
  ok("allow deploy repo arbitrary branch", allows({ remoteUrl: DEPLOY, refspec: "HEAD:release" }));
  ok("allow canonical deploy/* ref", allows({ remoteUrl: CANON, refspec: "HEAD:deploy/liveplace-fen172" }));
  ok("allow canonical deploy/* (plain)", allows({ remoteUrl: CANON, refspec: "deploy/liveplace-fen172" }));

  // basename precision: liveplace-deploy.git is NOT canonical.
  ok("liveplace-deploy.git not canonical", !isCanonicalRemote(DEPLOY));
  ok("liveplace.git is canonical", isCanonicalRemote(CANON));

  // empties refuse.
  ok("reject empty remote", rejects({ remoteUrl: "", refspec: "main" }));
  ok("reject empty refspec", rejects({ remoteUrl: CANON, refspec: "" }));

  console.log(`deploy-guard self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--selftest")) {
  selftest();
}
