# ADR-0009 — TanStack Router (SPA, client-side only)

**Date:** 2026-07-22
**Status:** Accepted
**Déciders:** CEO, Dev Full-stack (FEN-2096, plan FEN-2093)

---

## Contexte

Le routeur maison de LivePlace (`router.tsx`, FEN-45) est un fichier de ~300 lignes
de code: History API + `useSyncExternalStore` + un switch sur `resolveRoute`. Il fait
ce qu'on lui demande mais il est opaque aux outils (devtools, SSR future, prefetch,
code-splitting par route). La migration vers TanStack Router v1 est approuvée en FEN-2040.

## Décision

Adopter **TanStack Router v1** en mode **SPA 100 % client** (pas TanStack Start / SSR).

Points structurants :
- Routing file-based (`src/routes/`) + `routeTree.gen.ts` généré par `@tanstack/router-cli`.
- Pattern **strangler** : le catch-all `routes/$.tsx` délègue à `RouterInner` existant.
  Les 16 fichiers consommateurs (`usePathname`, `navigate`, `replace`, `Link`) gardent
  leurs signatures — ils importent le shim dans `router.tsx`.
- `scrollRestoration` global désactivé (parité avec l'existant, R3).
- `resolveRenderMode` / `isObsPath` restent synchrones dans le corps des composants,
  jamais dans un `loader` async (R2).
- OBS path handling (`isObsPath`) reste dans `RouterInner` → catch-all (synchrone, pas
  de loader async).

## Conséquences

**Positives**
- Routing typé (route params, search params) dès les vraies routes TanStack.
- Prefetch, devtools, future lazy-route splitting natifs.
- Strangler progressif : les 16 consommateurs et le comportement existant sont intacts.

**Contraintes**
- `routeTree.gen.ts` est généré (`tsr generate`) avant le typecheck — les scripts
  `build` et `typecheck` embarquent ce step.
- `@tanstack/router-plugin` est ajouté au Vite config pour regénérer en mode dev.
- PAS TanStack Start : la SPA reste servie statiquement (Caddy SPA-fallback).
  Tout server-rendering futur fera l'objet d'un nouvel ADR.

## Alternatives écartées

- **react-router v7** — API mouvante, modèle loader/action trop couplé à Remix/server.
- **Garder le routeur maison** — pas de typage, pas d'écosystème, dette croissante.
