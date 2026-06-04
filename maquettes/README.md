# LivePlace — UI maquettes (design phase, FEN-196)

Standalone React + Vite + Tailwind v4 app that renders the LivePlace design
system + the 3 art directions for **LOCAL preview only** (`test-liveplace.nas`).
NOT production. NOT Coolify. NOT `liveplace.tv`.

## Build (for the test-liveplace.nas preview — FEN-195)
```bash
npm --prefix maquettes ci
npm --prefix maquettes run build      # -> maquettes/dist
```
Then publish to the preview edge (DevOps owns hosting):
```bash
# point scripts/preview-nas.sh at maquettes/dist, OR copy directly:
cp -a maquettes/dist/. preview/site/
scripts/preview-nas.sh up          # + `tunnel` for a remote review URL
```
The build is UI-only (no backend). Self-hosted fonts, all tokens are CSS
variables; the active art direction is set via `data-direction` on `<html>`.
