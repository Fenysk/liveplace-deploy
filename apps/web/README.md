# @canvas/web

Front-end SPA for LivePlace (React + Canvas 2D + Vite). Renders the live
collaborative canvas, the pose/erase UI, the OBS browser-source view and the
FR/EN i18n surface.

## Lancer en local pour la QA

> ⚠️ Sans `VITE_CONVEX_URL`, l'app boote une **page blanche** (le client Convex
> est instancié au chargement du module). C'est la cause #1 de friction QA
> ([FEN-322](/FEN/issues/FEN-322)). Configure l'env **avant** `dev`.

1. **Installer les deps** (depuis la racine du monorepo) :
   ```sh
   pnpm install
   ```

2. **Configurer l'env du front** — Vite lit le `.env` situé dans `apps/web/`
   (pas la racine du repo) :
   ```sh
   cp apps/web/.env.example apps/web/.env
   # puis éditer apps/web/.env (au minimum VITE_CONVEX_URL)
   ```
   Voir [`.env.example`](./.env.example) pour le détail de chaque variable.
   `VITE_CONVEX_URL` est **obligatoire** ; `VITE_CONVEX_SITE_URL` est requis pour
   la connexion Twitch / la pose de pixels.

3. **(optionnel) Backend Convex** — pour une URL Convex locale, lancer dans un
   autre terminal ; il imprime l'URL à reporter dans `VITE_CONVEX_URL` :
   ```sh
   pnpm --filter @canvas/convex dev
   ```

4. **Démarrer le front** :
   ```sh
   pnpm --filter @canvas/web dev
   ```
   L'app sert sur http://localhost:5173.

### Vue OBS (browser source)

La vue overlay épurée pour OBS est servie par la même app — pointer la *browser
source* OBS sur l'URL OBS de l'app une fois le `dev` lancé.

## Tests

```sh
pnpm --filter @canvas/web test    # tests unitaires (logique pure)
pnpm --filter @canvas/web build   # typecheck strict + build Vite
```
