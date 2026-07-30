# ADR-0007 — Converge the deploy lineage: one release trunk that carries the design (anti-clobber)

- Status: **Accepted**
- Date: 2026-07-07
- Owner / decider: Founding Engineer (owns architecture + lineage reconciliation, cf. ADR-0001)
- Issue: FEN-1629 (prevention for the FEN-1580 recurrence). Parent FEN-1625 / T1 (FEN-1627)
  handled the immediate redeploy; this ADR removes the structural cause.
- Affects: canonical `liveplace.git` `main`, `restore/fen-1580-neobrutalism`,
  the deploy bundle path (`scripts/coolify-wire-source.mjs`,
  `scripts/make-deploy-bundle.mjs`), new `scripts/lib/deploy-fingerprint.mjs`.
- Complements ADR-0005 (snapshot-vs-trunk push guard) and ADR-0001 (lineage reconciliation).

## Context — why the design keeps getting clobbered (3rd recurrence)

The neobrutalism design and a run of product fixes lived on
`restore/fen-1580-neobrutalism`, **never merged into the trunk**. Meanwhile the
trunk (`origin/main`) kept advancing with backend/infra work (rebuild guards,
migrations) on the **neutral S0** UI layer. The deploy bundle is built from
`git archive HEAD` (ADR-0005) — i.e. *whatever branch the deploying agent has
checked out* — so:

- a UI deploy checked out the design lineage → prod got the design;
- a backend/migration deploy checked out `main` → prod got neutral S0 and the
  design was **stripped** (FEN-1580 → FEN-1596 → FEN-1625).

The mechanism is **two divergent lineages + an ambiguous deploy source**. As long
as the design and the backend fixes live on different refs, any deploy from the
"wrong" ref silently reverts the other half. Redeploys (T1) fix the instant but
not the cause.

### The exact clobber signature

The neutral vs. design split is visible in one primitive, `apps/web/src/ui/styles/tokens.css`:

| Lineage | `--elev-1` |
| --- | --- |
| Design (neobrutalism) | `2px 2px 0 0 var(--ink)` (hard offset shadow) |
| Neutral **S0** (clobber) | `none` |

`--elev-*: none` in the served/bundled CSS is a reliable, deterministic
fingerprint that "the design was stripped." This ADR turns that into a guard.

### The lineage map at decision time

- `merge-base(origin/main, restore) = 86171d9` (FEN-1591).
- **restore-only:** FEN-1592 (design) + FEN-1611 + FEN-1616 + FEN-1613.
- **origin/main-only:** FEN-1598 + FEN-1600 (rebuild guards) + FEN-1613.
- `git merge-tree --write-tree origin/main restore` → **0 conflicts** (clean superset).
- Separately: FEN-1470–1476 (returnTo/auth-error work) sit on a **stale local
  `main` only**, never pushed to `origin` — a distinct, orphaned lineage (see
  Follow-up).

## Decision

**1. `main` is the single canonical release trunk, and it must carry the design.**
Executed here: `restore/fen-1580-neobrutalism` was merged (`--no-ff`) into
`origin/main`. The trunk now holds design **and** rebuild guards **and** every
recent fix — a strict superset. A deploy from `main` can no longer strip the
design because `main` *is* the design lineage.

**2. `restore/fen-1580-neobrutalism` is retired** as a divergent lineage. It is
fast-forwarded to the new `main` tip so the two refs are identical and cannot
re-diverge; all future work branches from `main`. Keeping a second long-lived
UI branch is exactly what caused the recurrence.

**3. Deploy from the trunk lineage only, and enforce it with a fingerprint guard
(defense-in-depth).** `scripts/lib/deploy-fingerprint.mjs` exports
`assertDesignFingerprint(cssText)`, which **throws** if the bundled
`tokens.css` resolves `--elev-1` (and siblings) to `none` — i.e. the neutral S0
clobber signature. It is called in the bundle path before the deploy push, and
ships a self-test:

```
node scripts/lib/deploy-fingerprint.mjs --selftest
```

This is the realizable form of option 3 (CI fingerprint check): even if a future
branch re-diverges to S0, a bundle built from it fails loud **before** it can
reach prod. Note its limit — it only guards the *scripted* bundle path; the
primary protection remains convergence (decision 1/2), which holds regardless of
the deploy mechanism (mirror force-push, Coolify force-deploy API, etc.).

## Options considered

1. **Merge `restore` → `main`, deploy from `main` — CHOSEN.** Clean merge (0
   conflicts), removes the divergence at the root, and is a single revertible
   merge commit. It does **not** trigger a prod deploy, so it carries no
   immediate prod risk.
2. **Make `restore` the official release branch, forbid deploy elsewhere.**
   Rejected as primary: it keeps two lineages alive and relies on procedure
   discipline that already failed three times; it also leaves the rebuild guards
   (which landed on `main`) off the release branch. Folded in instead: after the
   merge there is only *one* lineage, which is stronger than a rule about two.
3. **CI guard: reject a deploy whose served CSS has `--elev-*: none`.** Adopted
   as **defense-in-depth**, not as the sole fix — a guard on the scripted path
   cannot cover ad-hoc mirror pushes, and a guard without convergence would just
   block every backend deploy until someone re-reconciles by hand.

## Consequences

- Backend/migration deploys from `main` now ship the design by construction; the
  FEN-1580 class of incident is structurally retired, not just patched.
- One trunk to reason about; new branches fork from `main`. `restore` is kept as
  a historical pointer (== `main`) and should not receive new divergent work.
- A future accidental re-divergence to S0 is caught by the fingerprint guard on
  the scripted bundle path, with a precise message naming `--elev-1: none`.
- This ADR does **not** redeploy prod; T1 (FEN-1627) already restored the design
  in prod. It makes the *next* deploy safe.

## Follow-up (out of scope for FEN-1629, flagged for the CEO)

The FEN-1470–1476 returnTo/auth-error commits are stranded on a **local-only
`main`** (never pushed to `origin`) and are not in the trunk. FEN-1611 (now on
`main`) covers the "return to canvas after Twitch OAuth" behaviour, so they are
likely superseded — but this should be confirmed and either cherry-picked or
formally abandoned under a dedicated ticket, not silently dropped.

## Verification

- `git merge-tree --write-tree origin/main restore` → 0 conflicts (pre-merge).
- Merged tree: `apps/web/src/ui/styles/tokens.css` → `--elev-1: 2px 2px 0 0
  var(--ink)` (design present) **and** `apps/worker/src/rebuild.ts` present
  (rebuild guards preserved).
- `node scripts/lib/deploy-fingerprint.mjs --selftest` → all cases pass,
  including the exact FEN-1580 `--elev-1: none` hazard.
- `node --test packages/redis-scripts` green after the two-FEN-1613 auto-merge.
