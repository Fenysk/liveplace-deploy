# LivePlace — Règles de release (lignée servie unique)

> **But.** Empêcher le correctif n°1 du projet : du code « fait » ou un design déjà
> validé **écrasé en prod** parce qu'on a déployé depuis la mauvaise lignée git, ou
> parce qu'on a considéré « committé = fini ». Ce fichier est la **règle opérable**
> côté DevOps ; il vit dans le repo à côté des [ADR](./adr/) et de l'
> [anti-patterns-register](./anti-patterns-register.md).
>
> **Origine.** Correctif FEN-1630 (règles C1 / C2 / C8), accepté par Alexis le 2026-07-08.
> S'appuie sur — et ne remplace pas — [ADR-0007](./adr/0007-deploy-lineage-convergence-anticlobber.md)
> (un trunk de release unique qui porte le design — la décision archi derrière C1),
> [ADR-0005](./adr/0005-deploy-snapshot-vs-canonical-trunk.md) (snapshot vs trunk) et
> [ADR-0001](./adr/0001-repo-lineage-reconciliation.md) (réconciliation de lignée).

## C1 — Release train unique

La prod se déploie depuis **une seule lignée réconciliée : le trunk canonique**.

- Depuis ADR-0007 (convergence FEN-1629), la lignée servie unique est **`origin/main`** — le
  trunk porte désormais **le design ET les fixes backend/infra** (superset). Le snapshot Coolify
  est un **artefact parentless** bundlé depuis ce trunk (`git archive HEAD`, ADR-0005), poussé
  au repo de déploiement — jamais une seconde branche UI/backend de longue durée.
- **Interdit de déployer depuis une branche non mergée** (`fe/main`, `src/*`, `restore/*`,
  feature). Deux lignées divergentes + source de deploy ambiguë = **le design ou les fixes
  écrasés silencieusement** (FEN-1580→1596→1625). On **merge dans `main`**, on vérifie la
  réconciliation (`git merge-tree` clean superset), puis on bundle/déploie **depuis `main`**.
- Tout **changement de topologie de lignée** (nouvelle branche servie, re-parent, force-push,
  changement de remote/target Coolify) passe par un **ADR** (`docs/adr/NNNN-*.md`), **jamais**
  une manœuvre git ad hoc. Deux gardes le font respecter par du code : `deploy-guard.mjs`
  (frontière snapshot↔canonique, ADR-0005) et `deploy-fingerprint.mjs` (rejette un bundle S0
  qui a stripé le design, ADR-0007). L'ADR reste la trace de la décision.

## C2 — Definition of Done opposable

« Fini » **n'est jamais « committé »**. Un ticket est `done` seulement quand :

1. **mergé** dans la lignée servie (`origin/main`, cf. ADR-0007), et
2. **déployé** (Coolify — cf. [runbook](./runbooks/coolify-deploy.md)), et
3. **vérifié sur la surface réelle servie** (pas le build local), et
4. **ticket fermé** avec la preuve.

Preuve = **marqueur anti-stale** observé sur `https://liveplace.tv` (hash d'entry/chunk qui
change, classe CSS ou string-literal unique présent/absent, endpoint qui répond), **pas** le
hash local (l'env de build Docker ≠ sandbox). Un `git push` + « ça devrait être live » **ne
ferme pas** un ticket.

## C8 — Exécutions ops lisibles

Tout seam d'exécution est **explicite et son résultat est lu**.

- Un déploiement, une migration, un cron, un smoke-test, un cleanup : on **lit le résultat**
  (code retour, log, réponse HTTP, état servi). Une exécution **dont on ne lit pas le résultat
  n'est pas terminée** — elle est `in_progress` ou `blocked`, pas `done`.
- Piège récurrent : un GET sur l'ancien asset post-rollover renvoie le **SPA fallback HTML**
  (200 trompeur) ; un `convex run` d'une query `null` **n'imprime rien** (≠ `done`). Toujours
  vérifier via un marqueur autoritatif, pas via l'absence d'erreur.

---

### Checklist release (à dérouler avant de passer un deploy en `done`)

- [ ] Change **mergé dans `origin/main`** (pas déployé depuis une branche non mergée) — C1
- [ ] Si topologie de lignée touchée → **ADR écrit** — C1
- [ ] Coolify build **vert** + rollover terminé (`/healthz` 200) — C8
- [ ] **Marqueur anti-stale vérifié sur la surface servie** (pas le build local) — C2 / C8
- [ ] Smoke runtime lu (OAuth / WS `seq` anon-reject) — C8
- [ ] Ticket fermé avec la preuve citée — C2
