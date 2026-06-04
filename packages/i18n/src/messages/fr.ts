import type { Catalog } from "./en.js";

/**
 * French catalog. Typed as {@link Catalog}, so it MUST mirror every key in the
 * English source of truth — a missing or extra key is a compile error.
 */
export const fr: Catalog = {
  // App shell
  "app.title": "LivePlace",
  "app.tagline": "Une toile de pixels collaborative, en direct sur Twitch",

  // Navigation
  "nav.primary": "Navigation principale",
  "nav.skipToContent": "Aller au contenu",
  "nav.canvas": "Toile",
  "nav.gallery": "Galerie",
  "nav.leaderboard": "Classement",
  "nav.profile": "Profil",
  "nav.myProfile": "Ton profil",
  "nav.studio": "Studio",

  // 404 (FEN-114)
  "notFound.title": "Page introuvable",
  "notFound.body": "Cette page n'existe pas ou a été déplacée.",
  "notFound.backToCanvas": "Retour à la toile",

  // Auth (F1)
  "auth.signIn": "Se connecter avec Twitch",
  "auth.signOut": "Se déconnecter",
  "auth.signedInAs": "Connecté en tant que {name}",

  // Language switcher (F13)
  "lang.label": "Langue",
  "lang.en": "English",
  "lang.fr": "Français",

  // Canvas / gauge (F3–F5)
  "canvas.ready": "Prêt à poser",
  "canvas.cooldown": "Prochain pixel dans {seconds}s",
  "canvas.place": "Poser un pixel",
  "canvas.erase": "Gommer",
  "canvas.gauge": "{current}/{max} pixels",
  "canvas.palette": "Palette de couleurs",
  "canvas.viewers": "{count} en train de regarder",
  "canvas.connecting": "Connexion…",
  "canvas.offline": "Reconnexion…",

  // État unifié « puis-je poser ? » (UX Lot E, FEN-117) — un seul indicateur,
  // oui/non + pourquoi + quand, un libellé texte par état (C6, jamais la couleur seule).
  "canvas.state.loading": "La fresque arrive…",
  "canvas.state.ready": "Tu peux poser — {charges} pixels prêts",
  "canvas.state.ready.one": "Tu peux poser — 1 pixel prêt",
  // Pas de {seconds} ici : le décompte par seconde est porté par la ligne Lot F
  // (canvas.cooldown.*), orientée futur. Cette ligne rang-1 reste statique → un
  // lecteur d'écran l'entend une fois, pas à chaque tic (FEN-165, finding 1+2).
  "canvas.state.cooldown": "Plus de pixels — recharge en cours",
  "canvas.state.signedOut": "Connecte-toi avec Twitch pour poser",
  "canvas.state.frozen": "La pose est en pause",
  "canvas.state.notStarted": "Ça ouvre à {time}",
  "canvas.state.notStarted.tomorrow": "Ça ouvre demain à {time}",
  "canvas.state.notStarted.date": "Ça ouvre le {date} à {time}",
  "canvas.state.ended": "L'événement est terminé",
  "canvas.state.archived": "Fresque terminée — en lecture seule",
  "canvas.state.banned": "Tu ne peux plus poser sur cette fresque",
  "canvas.state.notFound": "Cette fresque est introuvable",

  // Lisibilité viewer des événements de modération (Lot I, FEN-121)
  "canvas.moderation.areaChanged": "Une zone vient d'être modifiée",
  "canvas.moderation.paused": "La pose vient d'être mise en pause",
  "canvas.moderation.reopened": "La pose est de nouveau ouverte",

  // Retour de pose sur la toile (F4) — pose/gomme optimiste + rollback (FEN-60)
  "canvas.feedback.cooldown": "En attente — prochain pixel dans {seconds}s",
  "canvas.feedback.banned": "Tu es banni de cette toile",
  "canvas.feedback.outOfBounds": "Ce pixel est hors de la toile",
  "canvas.feedback.invalidColor": "Choisis une couleur de la palette",
  "canvas.feedback.rateLimited": "Doucement — réessaie dans un instant",
  "canvas.feedback.signInRequired": "Connecte-toi avec Twitch pour poser des pixels",
  "canvas.feedback.error": "Impossible de poser ce pixel — réessaie",
  "canvas.feedback.capReached": "Jauge pleine ({max}) — valide ou retire une case",
  "canvas.feedback.placed": "✓ {count} posé·s",
  "canvas.feedback.updated": "✓ {count} mis à jour",

  // Pose en lot : modèle « sélection → validation » (FEN-113, raffinements FEN-124)
  "canvas.draw": "Dessiner",
  "canvas.placeHere": "Poser ici",
  "canvas.validate": "Valider {count}",
  "canvas.cancel": "Annuler",
  "canvas.finish": "Terminer",
  "canvas.drawingMode": "Mode dessin",
  "canvas.batchCount": "{count}/{max} sélectionnées",
  "canvas.batchHint": "Sélectionne une case, puis Valider",
  "canvas.zoomHint": "Zoome pour poser avec précision",

  // Cooldown actif — transformer l'attente en anticipation (UX Lot F, FEN-119).
  // Décompte orienté futur : viser/armer sa prochaine case pendant la recharge,
  // puis la poser en un geste à 0:00. Pas de « skip cooldown » — on vise en avance.
  "canvas.armHere": "Viser pour la recharge",
  // Les libellés de phase ne portent AUCUN {seconds} : la valeur qui défile est
  // rendue dans un span aria-hidden distinct (canvas.cooldown.seconds), pour que
  // la région live n'annonce que les changements de phase, pas chaque seconde
  // (FEN-165, finding 1). Le décompte visuel par seconde reste pour les voyants.
  "canvas.cooldown.waiting": "Vise ta prochaine case pendant la recharge",
  "canvas.cooldown.armed": "Prochaine case prête — pose à la recharge",
  "canvas.cooldown.ready": "Rechargé — valide pour poser ta case",
  // Compteur visuel uniquement, recopié dans un span aria-hidden (FEN-165).
  "canvas.cooldown.seconds": "{seconds}s",

  // Pose au clavier + annonces lecteur d'écran (FEN-123, WCAG 2.1.1 / 4.1.3)
  "canvas.canvasLabel": "Canevas de pixels",
  "canvas.keyboardHelp":
    "Utilise les flèches pour viser une case, maintiens Maj pour aller plus vite. Entrée ou Espace pour sélectionner, moins et plus pour zoomer, Échap pour effacer, et Ctrl+Entrée pour valider.",
  "canvas.cursorAt": "Case {x}, {y}",
  "canvas.cursorAtStaged": "Case {x}, {y}, sélectionnée",

  // Claim de palier — progression de la réserve (Lot D / FEN-116). Jauge seule ; aucun point/boutique.
  "canvas.claim.available": "Réserve +1 !",
  "canvas.claim.stacked": "{count} paliers à encaisser",
  "canvas.claim.action": "Agrandir ma réserve",
  "canvas.claim.actionOne": "Agrandir ma réserve (+1)",
  "canvas.claim.all": "Tout encaisser ({count})",
  "canvas.claim.celebrate": "Réserve agrandie — {max} pixels !",

  // Onboarding adaptatif just-in-time (FEN-118) — hints contextuels, non bloquants
  "canvas.onboarding.arrival": "Pose des pixels sur la fresque en direct — essaie !",
  "canvas.onboarding.aim": "Vise une case, choisis ta couleur",
  "canvas.onboarding.firstPixel": "Posé ! Tes pixels sont limités — ils se rechargent avec le temps",
  "canvas.onboarding.gaugeEmpty": "Plus de pixels — recharge dans {seconds}s. Prépare ta prochaine case",
  "canvas.onboarding.pointsThreshold": "Tu as gagné de la réserve — appuie sur « Agrandir ma réserve » pour l'encaisser",
  "canvas.onboarding.help": "Besoin d'un coup de main ?",
  "canvas.onboarding.howto": "Comment ça marche",
  "canvas.onboarding.dismiss": "OK",

  // Public profile (F11) — consumed by ProfilePage / profileView
  // `profile.notFound` = titre ; `.body`/`.cta` = affordance de récupération
  // équivalente au 404 (FEN-125).
  "profile.notFound": "Profil introuvable",
  "profile.notFound.body": "Aucun joueur ne correspond à ce nom — il a peut-être changé, ou n'a jamais existé.",
  "profile.notFound.cta": "Découvrir les toiles",
  "profile.memberSince": "Membre depuis {date}",
  "profile.totals": "Totaux",
  "profile.pixelsPlaced": "Pixels posés",
  "profile.points": "Points",
  "profile.canvasesJoined": "Toiles rejointes",
  "profile.canvas": "Toile",
  "profile.bestRank": "Meilleur rang",
  "profile.rank": "n°{rank}",
  "profile.empty": "Aucune toile rejointe pour l'instant.",

  // Galerie publique (F12) — consommée par GalleryPage / galleryView
  "gallery.title": "Découvrir les toiles",
  "gallery.viewers": "{count} spectateurs",
  "gallery.empty": "Aucune toile publique en direct pour le moment.",
  "gallery.emptyCta": "Ouvrir la toile en direct",
  "gallery.viewStreamer": "Voir le profil de {name}",

  // Espace streamer (F9/F10/F11) — tableau de bord / création / diffuser (FEN-120)
  "studio.title": "Mes canvas",
  "studio.new": "Nouveau canvas",
  "studio.signInPrompt": "Connecte-toi avec Twitch pour créer et gérer tes canvas.",
  "studio.empty.title": "Aucun canvas pour l'instant",
  "studio.empty.body": "Crée-en un pour peindre en direct avec ton chat.",
  "studio.empty.cta": "Créer ton premier canvas",
  "studio.noActive.body": "Aucun de tes canvas n'est actif pour l'instant — crée-en un nouveau ou réactive une archive ci-dessous.",
  "studio.active.label": "Actif",
  "studio.active.dimensions": "Grille {width}×{height}",
  "studio.status.open": "Pose ouverte",
  "studio.status.frozen": "Pose en pause",
  "studio.visibility.public": "Public",
  "studio.visibility.private": "Privé",
  "studio.action.broadcast": "Diffuser (OBS)",
  "studio.action.openCanvas": "Ouvrir le canvas",
  "studio.action.freeze": "Mettre la pose en pause",
  "studio.action.unfreeze": "Rouvrir la pose",
  "studio.announce.frozen": "Pose mise en pause.",
  "studio.announce.reopened": "Pose rouverte.",
  "studio.announce.activated": "« {title} » est maintenant ton canvas actif.",
  "studio.archives.title": "Archives (lecture seule)",
  "studio.archives.empty": "Aucune archive pour l'instant.",
  "studio.archives.archivedOn": "archivé le {date}",
  "studio.archives.reactivate": "Réactiver",
  "studio.archives.reactivateConfirm": "« {active} » passera hors ligne et « {next} » deviendra ton canvas actif. Continuer ?",
  "studio.create.title": "Nouveau canvas",
  "studio.create.nameLabel": "Nom du canvas",
  "studio.create.namePlaceholder": "ex. Neon City",
  "studio.create.nameHint": "Laisse vide pour un nom par défaut.",
  "studio.create.submit": "Créer",
  "studio.create.creating": "Création…",
  "studio.create.advanced": "Options (défauts pré-remplis)",
  "studio.create.sizeLabel": "Taille",
  "studio.create.paletteLabel": "Palette",
  "studio.create.paletteDefault": "Palette par défaut",
  "studio.create.publicLabel": "Afficher dans la galerie publique",
  "studio.create.publicHint": "Désactivé : non listé — visible seulement via le lien.",
  "studio.create.nameTooLong": "Le nom doit faire 80 caractères ou moins.",
  "studio.create.errorNameTaken": "Ce nom est déjà pris — essaie-en un autre.",
  "studio.create.error": "Impossible de créer le canvas — réessaie.",
  "studio.create.back": "Retour au tableau de bord",
  "studio.size.small": "Petit (50×50)",
  "studio.size.small.hint": "Intime et très lisible — parfait pour un petit groupe.",
  "studio.size.medium": "Moyen (100×100)",
  "studio.size.medium.hint": "Équilibré — le défaut recommandé.",
  "studio.size.large": "Grand (250×250)",
  "studio.size.large.hint": "De la place pour une grosse foule, mais moins lisible de près.",
  "studio.broadcast.title": "Diffuser dans ton stream",
  "studio.broadcast.subtitle": "Ajoute-le comme source Navigateur dans OBS — en moins de 2 minutes.",
  "studio.broadcast.urlLabel": "URL pour OBS (source navigateur)",
  "studio.broadcast.copy": "Copier",
  "studio.broadcast.copied": "Copié !",
  "studio.broadcast.copyManual": "Copie automatique impossible — l'URL est sélectionnée, fais Ctrl/⌘+C.",
  "studio.broadcast.step1": "Ajoute une source « Navigateur » dans OBS.",
  "studio.broadcast.step2": "Colle cette URL dedans.",
  "studio.broadcast.step3": "Ajuste la taille à ta scène.",
  "studio.broadcast.checklist": "Tu dois voir ta fresque apparaître.",
  "studio.broadcast.preview": "Ouvrir la vue OBS dans un onglet",
  "studio.broadcast.advanced": "Réglages avancés OBS (fond, grille, zoom…)",
  "studio.broadcast.advancedBody": "Ajoute des options d'URL comme ?bg=000000&grid=1&zoom=8 pour cadrer l'overlay.",
  "studio.broadcast.notFound": "Ce canvas n'existe pas ou ne t'appartient pas.",
  "studio.broadcast.back": "Retour au tableau de bord",

  // Panneau de crise streamer (Lot I, FEN-121) — réagir à un raid sans paniquer
  "studio.crisis.status.calm": "Pose ouverte — gel d'urgence prêt",
  "studio.crisis.status.frozen": "Pose gelée — agis, puis rouvre",
  "studio.crisis.freeze": "Geler la pose",
  "studio.crisis.reopen": "Rouvrir la pose",
  "studio.crisis.ban": "Bannir un auteur",
  "studio.crisis.wipe": "Effacer une zone",
  "studio.crisis.restore": "Annuler cet effacement",
  "studio.crisis.wipeWarning": "Effacer fait réapparaître ce qui était dessous.",
  "studio.crisis.firstHint": "En cas de souci, gèle la pose ici.",
  "studio.crisis.banPrompt": "Choisis l'auteur à bannir sur la fresque.",
  "studio.crisis.wipePrompt": "Choisis la zone à effacer sur la fresque.",
  "studio.crisis.announce.frozen": "Pose gelée — les outils de crise sont disponibles.",
  "studio.crisis.announce.reopened": "Pose rouverte.",

  // Surfaces de sélection ban/effacement/restauration (FEN-160 / spec FEN-157 §5).
  "studio.crisis.ban.mode": "Mode bannir — choisis un pixel de l'auteur",
  "studio.crisis.ban.empty": "Aucun pixel d'un auteur ici — choisis un pixel coloré.",
  "studio.crisis.ban.confirm": "Bannir {author} et retirer tous ses pixels ?",
  "studio.crisis.ban.confirmCount": "{count} pixels seront retirés.",
  "studio.crisis.ban.protected": "Tu ne peux pas bannir un modérateur ou le propriétaire.",
  "studio.crisis.ban.success": "Auteur banni — {count} pixels retirés.",
  "studio.crisis.ban.successPending": "Auteur banni — retrait des pixels en attente (diffusion non connectée).",
  "studio.crisis.ban.error": "Bannissement non appliqué — réessaie.",
  "studio.crisis.ban.anonAuthor": "cet auteur",
  "studio.crisis.wipe.mode": "Mode effacer — délimite une zone",
  "studio.crisis.wipe.count": "Zone : {count} cellules",
  "studio.crisis.wipe.empty": "Sélectionne au moins une cellule.",
  "studio.crisis.wipe.confirm": "Effacer {count} cellules ? Ce qui était dessous réapparaît.",
  "studio.crisis.wipe.large": "Grande zone ({count} cellules) — confirme l'effacement.",
  "studio.crisis.wipe.success": "{count} cellules effacées.",
  "studio.crisis.wipe.successPending": "Effacement enregistré — retrait en attente (diffusion non connectée).",
  "studio.crisis.wipe.error": "Effacement non appliqué — réessaie.",
  "studio.crisis.cancel": "Annuler",
  "studio.crisis.cancelled": "Annulé.",
  "studio.crisis.history.title": "Actions récentes",
  "studio.crisis.history.empty": "Aucune action récente.",
  "studio.crisis.history.error": "Historique indisponible — réessaie.",
  "studio.crisis.history.wipeRow": "Effacement — {count} cellules",
  "studio.crisis.history.banRow": "Bannissement de {author} — {count} pixels",
  "studio.crisis.history.restored": "Restauré",
  "studio.crisis.restore.confirm": "Restaurer {count} pixels ? Les poses récentes sur ces cellules seront recouvertes.",
  "studio.crisis.restore.success": "{count} pixels restaurés.",

  // Generic
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.retry": "Réessayer",
  "common.loadMore": "Voir plus",
};
