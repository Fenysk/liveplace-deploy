# Maquette preview on the shared NAS (FEN-1478)

Reproducible, isolated way to serve an **autonomous static design maquette**
(e.g. the FEN-1477 Neobrutalism canvas-viewer) behind a `*.nas` domain for Alexis
to validate. **Not Coolify, not prod, not liveplace.tv.**

```
browser  ──http://test-liveplace.nas/──▶  dns-router-caddy (host :80, host net)
                                              │  reverse_proxy localhost:8095
                                              ▼
                                   liveplace-maquette  (caddy file_server)
                                   127.0.0.1:8095 → /srv (the maquette folder, ro)
```

Two ownership layers are involved:

| Layer | Owner | This deliverable |
|---|---|---|
| Static file server (`liveplace-maquette` container) | **DevOps (us)** | ✅ this folder |
| Caddy edge route `test-liveplace.nas → localhost:8095` | nas-dashboard self-service (`POST /api/domains`) | ✅ we register it |
| DNS `test-liveplace.nas` (dnsmasq allowlist) | **`hermes` infra account** (`~/infra-config/services.yml`) | ⚠️ infra-owner action — see step 4 |

## 1. Copy the maquette folder to the NAS

The maquette lives on its design branch only, so ship the folder out-of-band
(no rsync on the controller — use tar over ssh):

```bash
# from the repo root, on the branch that has the maquette:
tar -C design/maquettes -czf - fen-1477-neobrutalism-canvas-viewer \
  | ssh paperclip@192.168.1.98 'mkdir -p ~/deploy/liveplace-maquette/site && \
      tar -C ~/deploy/liveplace-maquette/site -xzf -'
# also ship the compose + Caddyfile:
scp deploy/nas/maquette-preview/{docker-compose.maquette.yml,Caddyfile} \
    paperclip@192.168.1.98:~/deploy/liveplace-maquette/
```

## 2. Bring the preview up (loopback-only)

```bash
ssh paperclip@192.168.1.98
cd ~/deploy/liveplace-maquette
MAQUETTE_DIR=$PWD/site/fen-1477-neobrutalism-canvas-viewer MAQUETTE_PORT=8095 \
  docker compose -p liveplace-maquette -f docker-compose.maquette.yml up -d
# smoke:
curl -fsS http://127.0.0.1:8095/healthz                  # -> ok
curl -fsS http://127.0.0.1:8095/ | grep -o '<title>[^<]*' # -> the maquette title
```

## 3. Register the edge route (self-service, nas-dashboard)

The live Caddy config is owned by `nas-dashboard` (`dashboard.nas`), which renders
the full config from `domain-mappings.json` and atomically pushes it to the Caddy
admin API. Adding our route is additive and reversible:

```bash
# add
curl -fsS -X POST http://127.0.0.1:9120/api/domains \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-liveplace","target":"localhost:8095"}'
# verify the route now serves the maquette (DNS not required for this check):
curl -fsS -H 'Host: test-liveplace.nas' http://127.0.0.1:80/ | grep -o '<title>[^<]*'
# rollback (if ever needed)
curl -fsS -X DELETE http://127.0.0.1:9120/api/domains/test-liveplace
```

## 4. DNS — infra-owner action (`hermes`)

dnsmasq has **no `*.nas` wildcard**; a new host is `NXDOMAIN` until allowlisted.
`~/infra-config/services.yml` (the source of truth) is owned by `hermes` and is not
writable by `paperclip`, so this one step needs the infra owner. **Preferred** fix
(also completes the dashboard migration so every future self-service route just
works):

```bash
# as hermes, in ~/infra-config — add a single wildcard to dns generation, OR the
# minimal per-host entry below, then regenerate + reload DNS:
./add-service.sh test-liveplace 8095 "FEN-1478 Neobrutalism maquette preview"
python3 generator.py && ./deploy.sh     # deploy.sh restarts ONLY dnsmasq (Caddy untouched)
```

Minimal alternative (one line in `dnsmasq.conf.auto` + `docker compose restart dnsmasq`):
`address=/test-liveplace.nas/100.74.250.38`

After DNS is live: `http://test-liveplace.nas/` renders the maquette in a real
browser, desktop and mobile.

## Teardown

```bash
docker compose -p liveplace-maquette -f docker-compose.maquette.yml down
curl -fsS -X DELETE http://127.0.0.1:9120/api/domains/test-liveplace   # drop the route
# ask hermes to remove the dnsmasq entry if the preview is retired
```
