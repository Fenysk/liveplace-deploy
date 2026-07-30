# Runbook — CI lint gate (FEN-661 / A8 criterion C6)

Enforce the ESLint baseline (`pnpm lint` → `eslint . --max-warnings 0`, 0 problems)
on every push to `main` and every PR targeting it, so a future change can never
silently re-introduce lint violations. Parent: FEN-657 (baseline land).

## The gate

`.github/workflows/ci.yml` — job **`lint`**, required/blocking:

1. checkout
2. `pnpm/action-setup@v4` (pnpm version from `packageManager` in `package.json`)
3. `actions/setup-node@v4` (Node 20, pnpm cache)
4. `pnpm install --frozen-lockfile --prod=false` — installs devDependencies
   (ESLint + typescript-eslint are devDeps; `--prod=false` is required, and
   `--frozen-lockfile` keeps it reproducible / fails on a stale lockfile)
5. `pnpm lint --max-warnings 0` — any error **or** warning fails the build

It runs as its own fast job (no build first), so a violation fails fast.

**Done-when:** a push/PR onto `main` carrying a lint violation turns the `lint`
check red and blocks merge. To make it strictly merge-blocking on the GitHub
host, add `lint` to the branch-protection required status checks for `main`
(Settings → Branches → Branch protection rules → Require status checks).

## Why GitHub Actions and not a build-time stage

Per ADR-0005 the canonical trunk (`liveplace.git`) is an internal bare repo and
the Coolify deploy clones a **flat, parentless snapshot** of the deploy repo. The
deploy build pack is not a pre-merge gate — it runs *after* code is already on
the trunk. A pre-merge lint gate belongs in CI on the host that owns `main`, so
the workflow lives in `.github/workflows/` and activates on the GitHub-hosted
trunk. The local hook below covers developers working against the bare remote.

## Optional: local pre-commit mirror (no new dependency)

`scripts/hooks/pre-commit` runs the same gate before each commit. Opt in once
per clone:

```bash
git config core.hooksPath scripts/hooks
```

Plain git hook — no husky, no added devDependency (stack changes are Alexis's to
make). Bypass a single commit with `git commit --no-verify`.

## Verifying the gate works

```bash
pnpm install --frozen-lockfile --prod=false
pnpm lint --max-warnings 0    # exit 0 on a clean tree
# introduce e.g. an unused non-_ var, re-run → exit 1, build fails
```
