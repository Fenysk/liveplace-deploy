# Runbook — Publishing the UI maquettes preview (GitHub Pages)

**Live URL:** https://fenysk.github.io/liveplace-ui-preview/ (always-on, 24/7, HTTPS)
**Pages repo:** `Fenysk/liveplace-ui-preview` (dedicated, public)
**Owner of the rail:** DevOps (set up on FEN-195). **Owner of the content:** UI Designer.

This is the canonical, reproducible republish flow used at every maquettes
iteration (FEN-204). It replaces the earlier ad-hoc token-paste publish.
Do **not** use ephemeral tunnels (Cloudflare quick-tunnel) — they die with the
sandbox/overnight recycle. This is **not** prod (prod = Coolify VPS / liveplace.tv).

## One-time / per-iteration flow

```sh
# 1. Build the maquettes with the CORRECT Pages base path (absolute, not ./).
#    GitHub Pages serves this as a PROJECT site under /liveplace-ui-preview/,
#    so client-side deep-links need an absolute asset base or they 404.
#    (Adjust to however the maquettes app is built; the key is --base.)
vite build --base=/liveplace-ui-preview/      # → outputs to preview/site (or your dist)

# 2. Publish. The script clones the Pages repo, mirrors the dist in, adds the
#    SPA 404.html fallback + .nojekyll, commits and pushes. Idempotent.
GITHUB_TOKEN=<token-with-repo-scope> node scripts/publish-preview-pages.mjs preview/site

# 3. Verify (Pages serves the update in ~30–60s).
curl -s -o /dev/null -w '%{http_code}\n' https://fenysk.github.io/liveplace-ui-preview/
```

## What the script guarantees

- **Base-path lint:** refuses to publish a relative-base (`./assets`) build that
  would break deep-links on Pages. Override with `--allow-relative-base` only if
  you accept that only the entry page works.
- **SPA fallback:** copies `index.html` → `404.html` so deep-links render the SPA.
- **`.nojekyll`:** so `_`-prefixed asset dirs are served verbatim.
- **No-op safe:** if the Pages content is unchanged, it pushes nothing.
- **Secrets stay out of the repo:** `GITHUB_TOKEN` is read from the env (or the
  gitignored `infra/coolify/deploy.env`) and injected into the push URL in memory only.

## Flags / env

| Var / flag              | Default                        | Purpose                                  |
| ----------------------- | ------------------------------ | ---------------------------------------- |
| `DIST_DIR` (positional) | `preview/site`                 | built maquettes to publish               |
| `GITHUB_TOKEN`          | —                              | required to push (`repo` scope)          |
| `PREVIEW_PAGES_REPO`    | `Fenysk/liveplace-ui-preview`  | target Pages repo                        |
| `PREVIEW_PAGES_BRANCH`  | `main`                         | branch Pages serves from                 |
| `--dry-run`             | off                            | assemble + lint, do not push             |
| `--allow-relative-base` | off                            | publish a relative-base build anyway     |

## Dry run (no token needed)

```sh
node scripts/publish-preview-pages.mjs --dry-run preview/site
```
