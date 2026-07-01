# Public design preview on PROD — FEN-1477 maquette (FEN-1478)

Serves the **FEN-1477 Neobrutalism canvas-viewer** design maquette on the prod
domain at:

**https://liveplace.tv/preview/fen-1477-neobrutalism/**

Alexis asked for the maquette "directement sur le site en prod" (dropping the
earlier `test-liveplace.nas` preview). This is served as an **isolated, additive,
fully reversible** deployment — it shares nothing with the live `liveplace`
stack.

## Architecture (why it is safe on prod)

```
browser ─https─▶ Coolify Traefik edge (liveplace.tv, TLS)
                   ├─ Host(liveplace.tv)                          ─▶ liveplace app (proxy → SPA/gateway/convex)   [UNTOUCHED]
                   └─ Host(liveplace.tv) && PathPrefix(/preview/fen-1477-neobrutalism)  ─▶ liveplace-maquette-fen1477 (caddy file_server)
```

- **Separate Coolify application** `liveplace-maquette-fen1477` in the LivePlace
  project (uuid `tgxjp2pout8sab9fp5edtbhb`), build pack `dockerfile`, port 80.
- **Separate Traefik router** scoped to the `/preview/fen-1477-neobrutalism`
  subpath (higher priority than the catch-all Host router). Everything else on
  `liveplace.tv` keeps routing to the live app.
- **No rebuild / no redeploy of the live stack.** The live `liveplace` app is
  never edited or restarted by this.
- **`noindex`** (`X-Robots-Tag` + `robots.txt` disallow) so the design preview
  never enters search indexes.

## Source & reproducibility

Buildable source (what Coolify pulls) lives in the isolated public repo
**`github.com/Fenysk/liveplace-maquette-fen1477`** (branch `master`):
`index.html` (the autonomous maquette) + the `Caddyfile` + `Dockerfile` mirrored
here. The maquette is a single self-contained file (fonts inlined base64, no
external/relative sub-resources), so the catch-all `rewrite * /index.html` in the
Caddyfile renders it whether or not Traefik strips the path prefix.

## Update / rollback

```bash
# update: push to the preview repo, then redeploy that ONE app
curl -H "Authorization: Bearer $COOLIFY_API_TOKEN_3" \
  "https://coolify.fenysk.fr/api/v1/deploy?uuid=<APP_UUID>"

# full teardown / rollback (live app untouched):
curl -X DELETE -H "Authorization: Bearer $COOLIFY_API_TOKEN_3" \
  "https://coolify.fenysk.fr/api/v1/applications/<APP_UUID>"
```

App uuid at first deploy: `d3nlgdrj4o71uayyp5nm5c61` (FEN-1478).
