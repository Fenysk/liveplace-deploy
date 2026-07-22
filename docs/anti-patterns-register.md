# LivePlace — Registre des anti-patterns

> **But.** Recenser les anti-patterns de programmation observés dans nos repos,
> discoveries et audits, pour ne pas les reproduire dans le backbone archi.
> Ce fichier est la copie **code-résidente** du registre : il vit dans le dépôt,
> à côté des [ADR](./adr/) et des [contrats](./contracts/), pour que tout dev qui
> travaille dans la codebase le lise sans quitter le repo.
>
> **Curation & propositions** se font sur le ticket board
> [FEN-572](/FEN/issues/FEN-572) (rattaché à l'épic refonte archi
> [FEN-546](/FEN/issues/FEN-546)). Le board reste le lieu de discussion/validation ;
> ce fichier est synchronisé depuis lui par le curateur. **En cas de divergence,
> le board fait foi pour le contenu, ce fichier fait foi pour le dev qui code.**
>
> **Barre d'admission (règle d'Alexis).** On ne note QUE les patterns qui, **dans
> ~90 % des cas, sont à éliminer**. Pas les choix contextuels, pas les « ça dépend ».
> Si un pattern est légitime dans une fraction non négligeable de cas, il n'a pas
> sa place ici — au mieux une note de nuance.
>
> **Curateur / propriétaire :** Founding Engineer (valide la barre 90 %,
> déduplique, range, synchronise board ↔ repo). Tout le monde peut proposer une entrée.

## Comment contribuer

1. Tu observes un anti-pattern dans du code (review, discovery, audit, bug).
2. Vérifie qu'il passe la **barre 90 %** (à supprimer dans la quasi-totalité des cas).
3. Propose l'entrée sur [FEN-572](/FEN/issues/FEN-572) avec le **gabarit** ci-dessous,
   un id `AP-NN` incrémental, et un lien vers le ticket source.
4. Si une entrée proche existe déjà, **complète-la** (ajoute le ticket à « Observé dans »),
   ne crée pas de doublon.
5. Le curateur valide la barre 90 % puis répercute l'entrée ici dans le même PR/commit
   que la review qui l'a révélée quand c'est possible.

### Gabarit d'entrée

```
### AP-NN — <nom court>
- **Symptôme :** comment on le reconnaît dans le code.
- **Pourquoi c'est mauvais :** le risque concret (bug, perf, maintenabilité, sécurité).
- **À faire à la place :** le pattern correct.
- **Observé dans :** [FEN-XXX](/FEN/issues/FEN-XXX).
```

---

## Anti-patterns recensés

> Entrées de départ (AP-01 → AP-09) distillées du teardown de l'ancien repo
> `liveplace_next` — voir [FEN-549](/FEN/issues/FEN-549) §4. Généralisées pour être
> réutilisables hors LivePlace.

### AP-01 — Logique métier noyée dans des procédures stockées non versionnées
- **Symptôme :** la règle métier vit dans des dizaines de fonctions DB (RPC/stored procs/triggers) au lieu du code applicatif ; pas dans le dépôt, pas de tests, nommage opaque.
- **Pourquoi c'est mauvais :** quasi-intestable hors d'une DB live, pas de typage partagé, migrations invisibles à la review, refactor à l'aveugle.
- **À faire à la place :** règles métier en code typé et versionné (TS/Convex/Nitro chez nous) ; ne réserver à la DB que ce qui DOIT y être (hot-path atomique borné et documenté, cf. [contracts/canvas-api.md](./contracts/canvas-api.md)).
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-02 — Check-then-write non atomique (TOCTOU)
- **Symptôme :** on lit un état (quota, stock, solde), on vérifie, puis on écrit — en plusieurs opérations sans transaction/atomicité.
- **Pourquoi c'est mauvais :** fenêtre de course → double dépense, dépassement de quota, états incohérents sous charge.
- **À faire à la place :** une seule opération atomique (script Lua Redis, transaction, compare-and-swap) qui check + write d'un bloc. C'est exactement le contrat de notre hot-path pixel/cooldown.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-03 — Travail lourd sur le chemin critique, rustiné avec des timeouts
- **Symptôme :** logique coûteuse (auth complète, requêtes DB) sur chaque navigation/requête, « réparée » avec des `Promise.race`/timeouts arbitraires, et parfois désactivée en prod derrière un TODO.
- **Pourquoi c'est mauvais :** latence systémique, timeouts visibles par l'utilisateur, fragilité ; le timeout masque le vrai problème de design.
- **À faire à la place :** garder le chemin critique léger ; déporter le travail lourd hors chemin (cache, edge, flag, async). Un timeout n'est pas un fix.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-04 — Utiliser le stockage durable comme transport temps réel haute fréquence
- **Symptôme :** une table de la base durable sert de transport de fan-out pour un flux temps réel à haute fréquence (une ligne par événement), maintenue à flot par un job de purge.
- **Pourquoi c'est mauvais :** pollue le stockage durable, couple le temps-réel à la DB, exige une purge, monte mal en charge sur un firehose.
- **À faire à la place :** un vrai bus (Redis pub/sub, WS gateway, broker) pour le fan-out chaud ; la DB ne stocke que le durable. C'est la motivation de notre découpe Redis pub/sub + WS gateway ([ADR-0003](./adr/0003-ws-gateway-topology.md)).
- **Nuance :** un *transactional outbox* (table d'événements écrite dans la même transaction que la donnée, relayée puis tronquée avec rétention bornée) reste légitime quand on a besoin des garanties transactionnelles. L'anti-pattern visé, c'est la table durable comme *transport temps réel* qui ne tient que grâce à une purge — pas tout usage de la DB comme file.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-05 — Dépendances mortes ou lourdes « au cas où »
- **Symptôme :** des libs lourdes dans `package.json` jamais importées dans `src/` (ex. un moteur de rendu inutilisé).
- **Pourquoi c'est mauvais :** bundle/installs alourdis, surface d'attaque et de maintenance accrue, fausse impression d'usage.
- **À faire à la place :** n'ajouter une dépendance que quand elle est réellement importée ; auditer/élaguer les deps avant tout portage.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-06 — Normaliser la dette lint (plafond de warnings statique > 0)
- **Symptôme :** la CI tolère un nombre fixe de warnings (`--max-warnings=250`) qui ne baisse jamais ; les warnings s'accumulent jusqu'au plafond sans jamais être traités.
- **Pourquoi c'est mauvais :** la dette devient invisible et permanente ; les vrais signaux se noient dans le bruit toléré.
- **À faire à la place :** seuil = 0 sur le gate CI (notre cas, greenfield). Sur un legacy qu'on ne peut pas mettre à 0 d'un coup, un *ratchet* qui ne fait que descendre (baseline figée, interdiction d'augmenter) est acceptable — jamais un plafond statique non nul qu'on laisse vivre indéfiniment.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-07 — Casts non typés aux frontières + erreurs avalées silencieusement
- **Symptôme :** on décode à la main des payloads externes/realtime avec des casts `as` non validés, et les `catch` font un « silent fail » partout.
- **Pourquoi c'est mauvais :** couplage fort UI ↔ shape non garantie ; les bugs et pannes passent inaperçus jusqu'en prod.
- **À faire à la place :** contrats typés et versionnés aux frontières (validation runtime type Zod), erreurs remontées/loggées, jamais avalées par défaut. Cf. nos [contrats](./contracts/) versionnés.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-08 — Stockage append-only sans politique de rétention décidée
- **Symptôme :** un journal/table append-only grossit indéfiniment alors qu'aucune politique de rétention (TTL, archivage, compaction, ou « on garde tout » assumé) n'a été décidée à la conception.
- **Pourquoi c'est mauvais :** coûts et latences qui dérivent, sauvegardes/migrations de plus en plus lourdes, dette qu'on découvre trop tard.
- **À faire à la place :** décider explicitement la rétention **dès la conception** (TTL / archivage / compaction). « Garder pour toujours » peut être valide (ledger, audit) mais doit être un choix assumé et chiffré, pas un défaut subi.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

### AP-09 — Nom trompeur qui ment sur le contenu
- **Symptôme :** une fonction/variable porte un nom qui contredit ce qu'elle fait (ex. `get_canvas_binary` qui renvoie en fait un JSON sparse, pas un binaire).
- **Pourquoi c'est mauvais :** induit en erreur lecteurs et reviewers, masque un mauvais choix d'implémentation, propage de faux a priori (perf, format).
- **À faire à la place :** nommer d'après ce que la chose fait réellement ; renommer dès qu'un écart nom↔comportement est repéré.
- **Observé dans :** [FEN-549](/FEN/issues/FEN-549).

> Vague 2 (AP-10 → AP-14) — distillée d'incidents prod récents (voir [FEN-1014](/FEN/issues/FEN-1014)).
> Chaque entrée a passé la barre 90 % et a été dédoublonnée contre AP-01 → AP-09.

### AP-10 — Défaut permissif pour un flag de sécurité/auth (fail-open)
- **Symptôme :** un toggle de sécurité prend une valeur **permissive** quand la variable d'env n'est pas définie — ex. `GATEWAY_AUTH_DISABLED ?? "1"` (dans l'ancien script de déploiement Coolify, depuis supprimé — FEN-2041/D1) qui **désactivait l'auth** à chaque déploiement où la variable manquait. Le défaut vit désormais côté runtime, sûr : `bool("GATEWAY_AUTH_DISABLED", false)` (`apps/gateway/src/config.ts`).
- **Pourquoi c'est mauvais :** un défaut fail-open finit presque toujours en prod par simple omission de config ; ici l'auth gateway désactivée silencieusement a fait passer tous les sockets en `{userId:"anon"}` (279 pixels mal attribués, non rétro-réparables). Un cran de sécurité doit échouer **du côté sûr**.
- **À faire à la place :** défaut = valeur sûre/restrictive (auth **activée**) ; rendre l'activation du bypass **explicite et bruyante** (opt-in jamais implicite, log clair au démarrage de l'état du flag).
- **Observé dans :** [FEN-978](/FEN/issues/FEN-978).

### AP-11 — Valeur sentinelle magique écrite en base au lieu de `null`
- **Symptôme :** l'absence (« pas d'auteur ») est représentée par une string littérale stockée en base (`userId="anon"`) au lieu de `null`.
- **Pourquoi c'est mauvais :** la sentinelle fuit dans les jointures et comparaisons (`pixelAuthor` ne matche aucun `profiles.authUserId`) → attribution silencieusement cassée et données corrompues **non rétro-réparables**. « Absent » et « valeur réelle » partagent alors le même espace de valeurs.
- **À faire à la place :** représenter l'absence par `null` (ou un type optionnel dédié) ; les requêtes traitent `null` explicitement. Jamais de string magique mélangée à l'espace des valeurs réelles.
- **Observé dans :** [FEN-978](/FEN/issues/FEN-978).

### AP-12 — État binaire booléen là où un 3e état « en cours de résolution » est requis
- **Symptôme :** un état asynchrone est modélisé en deux valeurs (`authenticated | anonymous`) sans état `loading` → le cas négatif est rendu pendant la résolution (flash du bouton « connexion Twitch » <100 ms pour un user déjà connecté).
- **Pourquoi c'est mauvais :** traiter « pas encore connu » comme le cas négatif provoque flash/flicker et des défauts erronés tant que l'async n'est pas résolu.
- **À faire à la place :** modèle 3 états explicite (`loading | authenticated | anonymous`) ; ne jamais rendre l'état négatif tant que la résolution n'est pas terminée.
- **Observé dans :** [FEN-909](/FEN/issues/FEN-909), [FEN-913](/FEN/issues/FEN-913).

### AP-13 — Sélecteur CSS catch-all imposant taille/layout à tous les descendants
- **Symptôme :** un sélecteur catch-all (`.parent > *`, `*`) applique des règles de **taille/layout** (ex. `min-height:44px`) à tous les descendants, y compris ceux ajoutés plus tard (séparateurs `<hr>`, wrappers) → 3 bandes grises fantômes dans le menu.
- **Pourquoi c'est mauvais :** un catch-all touche aussi les éléments futurs et non prévus → effets de bord visuels imprévisibles à chaque évolution du markup.
- **À faire à la place :** cibler les éléments voulus par **classe explicite** ; neutraliser les exceptions (`.lp-menu-divider{min-height:0}`).
- **Nuance :** les *resets* globaux sans effet de layout restent légitimes (`*{box-sizing:border-box}`, owl `* + *{margin-top}` pour l'espacement). L'anti-pattern visé = **taille/layout** imposés via catch-all, pas tout usage de `*`.
- **Observé dans :** [FEN-854](/FEN/issues/FEN-854).

### AP-14 — Source de vérité dupliquée pour le même état d'UI
- **Symptôme :** deux composants dérivent et rendent **indépendamment** la même information (`OfflineBanner` ET `StatusPill` affichant « Reconnexion… » sur WS `closed`) → double affichage de la même chose.
- **Pourquoi c'est mauvais :** deux rendus du même état divergent dans le temps (l'un évolue, l'autre non) et dupliquent l'info à l'écran ; la logique d'état est réécrite à deux endroits.
- **À faire à la place :** désigner un composant **canonique** pour chaque état ; les autres restent silencieux pour cet état (ou consomment le même état dérivé sans le re-rendre).
- **Observé dans :** [FEN-913](/FEN/issues/FEN-913).

---

*Registre initialisé le 2026-06-16 (CEO) à la demande d'Alexis sur [FEN-572](/FEN/issues/FEN-572).
Porté dans le backbone archi (ce fichier) le 2026-06-17 sous l'épic [FEN-546](/FEN/issues/FEN-546).
Seed = 9 anti-patterns généralisés depuis [FEN-549](/FEN/issues/FEN-549) §4 (revision 2 du board : AP-04/06/08 resserrés sur la barre 90 %).
Vague 2 le 2026-06-22 : AP-10 → AP-14 distillés d'incidents prod ([FEN-1014](/FEN/issues/FEN-1014)) — barre 90 % + dédoublonnage appliqués.
Validation de la barre 90 % + curation continue = Founding Engineer.*
