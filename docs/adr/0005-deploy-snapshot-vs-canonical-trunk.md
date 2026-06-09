# ADR-0005 — Deploy snapshot vs. canonical trunk (release convention)

- Status: **Accepted**
- Date: 2026-06-04
- Owner / decider: DevOps (FEN-180), prevention follow-up to FEN-179 (FE reconciliation)
- Affects: `scripts/coolify-wire-source.mjs`, `scripts/make-deploy-bundle.mjs`,
  `scripts/lib/deploy-guard.mjs` (new), the canonical remote `liveplace.git`, the
  public Coolify deploy repo `github.com/Fenysk/liveplace-deploy`. Refs: FEN-172
  (the deploy that severed the trunk), FEN-160 (commit dropped off `main`),
  FEN-179 (`origin/main` restored to `a8d56f1`, snapshot preserved at
  `deploy/liveplace-fen172`).

## Context

Coolify builds LivePlace by **cloning a git host and running the dockercompose
build pack**. The canonical Paperclip remote (`liveplace.git`) is internal and
unreachable from Coolify, so we publish a build artifact to a public deploy repo.

That artifact is intentionally a **parentless, secret-free `git init` snapshot**
(`make-deploy-bundle.mjs` → `git archive HEAD`; `coolify-wire-source.mjs` →
fresh `git init` + single commit + `git push --force HEAD:main`). It has **no
history** by design — no `.env`, no secrets, no prior commits.

Two distinct git lineages therefore exist, and conflating them is the hazard:

| Lineage | Remote | `main` content | History |
| --- | --- | --- | --- |
| **Canonical trunk** | `liveplace.git` (`origin`) | development trunk | real, contiguous (118+ commits) |
| **Deploy snapshot** | `liveplace-deploy.git` (`gh`) | a single flat build snapshot | parentless, no history |

### What went wrong (FEN-179)

In FEN-172 the flat deploy snapshot (`d1e73f5`) was pushed to the **canonical**
`liveplace.git` `main` instead of (only) the deploy repo. A parentless commit
force-pushed onto `main` **severed the 118-commit trunk** and dropped FEN-160 off
deployed `main`. FE reconciled it: `origin/main` restored to the real tip
`a8d56f1`, snapshot preserved at ref `deploy/liveplace-fen172`.

## Decision

**The canonical `liveplace.git` `main` is the development trunk and nothing else.
A deploy snapshot is an artifact and lives only on a deploy target.**

Concretely, a parentless deploy snapshot may push **only** to:

1. the **dedicated public deploy repo** (any remote whose basename is *not*
   `liveplace.git`), on any branch — this is what Coolify clones; **or**
2. the **`deploy/*` ref namespace** on any remote, including canonical
   (e.g. `deploy/liveplace-fen172`) — for preserving/archiving a snapshot.

Pushing a snapshot to canonical `liveplace.git` `main` / `master` / any feature
branch is **forbidden** and must **fail loud, before git runs**.

### Enforcement

`scripts/lib/deploy-guard.mjs` exports `assertSafeDeployPush({remoteUrl, refspec})`,
which throws unless the target is canonical-AND-`deploy/*` or a non-canonical
remote. It is called in `coolify-wire-source.mjs` immediately before the
`git push`. `make-deploy-bundle.mjs`'s manual-publish doc now points at a `deploy`
remote / `deploy/*` ref, never `origin main`. The guard ships with a self-test:

```
node scripts/lib/deploy-guard.mjs --selftest   # 14 cases, incl. the exact FEN-179 hazard
```

Canonical detection is by remote **basename**: `liveplace.git` (and bare
`liveplace`) are canonical; `liveplace-deploy.git` is not — so the dedicated
deploy repo is never mistaken for the trunk.

## Consequences

- A repeat of FEN-179 is structurally impossible from the bundle path: the guard
  rejects canonical-`main` snapshot pushes outright.
- Updating the deployed app = re-run `coolify-wire-source.mjs` (re-pushes to the
  deploy repo) or push to the deploy repo directly. Never `git push origin main`
  with a snapshot.
- Trunk integrity is independent of deploy cadence: `main` only ever advances by
  normal merges, never by a flattened artifact.

## Alternatives considered

- **Push real history to the deploy repo** — rejected: leaks `.env`/secrets and
  bloats the clone; the snapshot's secret-free flatness is a feature.
- **Branch-protect `main` on `liveplace.git`** — complementary, not sufficient:
  the remote is an internal bare repo without a protection layer, and the guard
  catches the mistake at the source (the tool), pre-push, with a precise message.
