# Runbook — Aperçu local des maquettes UI sur `test-liveplace.nas` (FEN-195)

> **But.** Servir les maquettes UI de LivePlace **en local** sur
> `test-liveplace.nas` pour qu'Alexis valide le design **hors production**.
> ⚠️ Ceci n'est **PAS** Coolify et **PAS** `liveplace.tv`. Stack isolée, jetable,
> sans backend, sans TLS, sans Twitch.

## Architecture (volontairement minimale)

```
  navigateur d'Alexis (LAN)
        │  http://test-liveplace.nas[:8088]
        ▼
  ┌─────────────────────────────┐   docker compose project: liveplace-preview
  │  preview  (caddy:2-alpine)   │   (réseau + cycle de vie SÉPARÉS de la prod)
  │   :80  file_server           │
  │   root = /srv/site  ◄────────┼── bind-mount  ./preview/site  (maquettes buildées)
  └─────────────────────────────┘
```

- **Un seul conteneur** : Caddy en serveur de fichiers statiques.
- **Aucune dépendance prod** : pas de Redis/Convex/gateway/auth, pas de volume
  partagé, projet compose distinct (`liveplace-preview`). `up`/`down` ici ne
  touchent jamais la prod.
- **Contenu servi** = `./preview/site`. Au départ un *placeholder* committé ;
  remplacé par le build réel des maquettes via `update` (voir plus bas).
- **HTTP only** sur le LAN (`:80` dans Caddy → accepte tous les hostnames, donc
  marche par `test-liveplace.nas`, par IP, ou via tunnel, sans surprise).

Fichiers :
- `docker-compose.preview.yml` — la stack preview isolée.
- `infra/preview/Caddyfile` — l'edge statique (HTTP, `/healthz`, SPA fallback).
- `preview/site/` — contenu servi (placeholder committé + build runtime).
- `scripts/preview-nas.sh` — wrapper une-commande.

## Démarrer / piloter l'aperçu (sur l'exécuteur Docker du NAS — PAS Coolify)

```bash
# depuis la racine du repo, sur le NAS
scripts/preview-nas.sh up        # démarre l'edge (placeholder par défaut)
scripts/preview-nas.sh smoke     # vérifie /healthz + / en local
scripts/preview-nas.sh status    # docker compose ps
scripts/preview-nas.sh logs      # logs en continu
scripts/preview-nas.sh down      # arrête et supprime la stack preview
```

Équivalent brut sans wrapper :
```bash
docker compose -f docker-compose.preview.yml up -d
```

Port hôte par défaut : **8088** (`PREVIEW_PORT` pour changer). Pour un
`http://test-liveplace.nas` **sans port**, mappe le port hôte 80 :
```bash
PREVIEW_PORT=80 scripts/preview-nas.sh up   # si :80 est libre sur le NAS (DSM ?)
```

## Flux de mise à jour des maquettes (UI Designer / Dev Frontend)

À chaque itération de design, une seule commande rebuild les maquettes et les
publie sur l'aperçu (le serveur sert le nouveau dossier immédiatement, **sans**
reconstruire le conteneur) :

```bash
scripts/preview-nas.sh update
# = pnpm --filter @canvas/web build  →  sync apps/web/dist → preview/site → up -d
```

Variante en deux temps (utile si le build se fait ailleurs/en CI) :
```bash
pnpm --filter @canvas/web build      # produit apps/web/dist
scripts/preview-nas.sh sync          # publie dist → preview/site
```

> Les maquettes = le SPA `@canvas/web`. L'aperçu est **UI-only** : les origines
> Convex publiques sont passées vides au build, donc aucun backend live n'est
> requis pour valider le visuel. Quand l'UI Designer livre une entrée de
> maquettes dédiée, il suffit de pointer le build dessus — le flux ci-dessus ne
> change pas.

## Vérification (smoke)

```bash
scripts/preview-nas.sh smoke
# attendu : "ok" sur /healthz, <!doctype html> sur /
```

Depuis un autre poste du LAN une fois le DNS en place :
```bash
curl -fsS http://test-liveplace.nas:8088/healthz   # -> ok
```

## Hébergement = chemin AGENT (pas une commande tendue à un humain)

Per règle #1, le `up` ne se sous-traite PAS à Alexis : il se lance via un hôte
**persistant** que l'agent pilote. Deux chemins, par préférence :

1. **Tunnel Cloudflare anonyme (recommandé, zéro compte/zéro DNS/zéro port).**
   ```bash
   scripts/preview-nas.sh tunnel        # = compose --profile tunnel up -d
   scripts/preview-nas.sh tunnel-url    # imprime https://<random>.trycloudflare.com
   ```
   Le conteneur `cloudflared` (`restart: unless-stopped`) tient l'URL publique
   HTTPS tant que l'hôte tourne. **Chemin prouvé de bout en bout** sur le
   placeholder (agent → edge CF → caddy → HTTP 200 sur `/healthz`, la page et le
   fallback SPA). L'URL est aléatoire et tourne au restart (OK pour une revue
   design ; une URL **stable** nécessiterait un named-tunnel + token de compte =
   account-bound).
2. **Exécuteur Docker du NAS** (hôte persistant) : `scripts/preview-nas.sh up`
   (+ `tunnel`) exécuté par l'agent **via cet exécuteur**, pas par Alexis.

> ⚠️ La persistance impose un hôte persistant. Le sandbox d'un heartbeat agent
> est **éphémère** (le tunnel y meurt à la fin du run) — il sert à *prouver* le
> chemin, pas à héberger. L'hébergement durable = NAS (ou hôte always-on que
> l'agent pilote). S'il n'existe **aucun** chemin agent vers un tel hôte
> non-Coolify, l'accès EXACT manquant à fournir (compte-bound, via CEO→Alexis)
> est : **un endpoint joignable + credential SSH pour le NAS** (host/port public
> ou hostname cloudflared-access + user + clé) avec Docker/Compose — OU un
> exécuteur NAS enregistré côté Paperclip. Une fois fourni, tout le reste
> (build, up, tunnel, smoke) est 100 % agent.

## Seul vrai point account/network-bound : DNS LAN `test-liveplace.nas` (OPTIONNEL)

Le hostname **littéral** `test-liveplace.nas` n'est résoluble que sur le réseau
d'Alexis (`.nas` n'est pas un TLD public). C'est le **seul** point lié à son
compte/réseau — et il est **optionnel** : l'URL du tunnel marche sans. À faire
seulement si Alexis veut le nom littéral en LAN :
- **Synology DNS Server** : zone `nas` → A `test-liveplace` → IP LAN du NAS, ou
- **DNS routeur / Pi-hole / AdGuard** → IP LAN du NAS, ou
- ligne `hosts` (`<IP_LAN_NAS>  test-liveplace.nas`) / accès direct `http://<IP_LAN_NAS>:8088/`.

> Le « va regarder » à Alexis attend les **vraies maquettes** ([FEN-196](/FEN/issues/FEN-196)).
> À leur arrivée : `update` → `tunnel-url` → on relaie UN lien cliquable au CEO.

## Garde-fous

- N'utilise **jamais** `docker-compose.yml` (prod) pour l'aperçu ; toujours
  `-f docker-compose.preview.yml`.
- Ne déploie **rien** de ceci sur Coolify / `liveplace.tv`.
- `preview/site` est un dossier de contenu **runtime** : son build n'est pas
  committé (`.gitignore` local), seul le placeholder l'est.
