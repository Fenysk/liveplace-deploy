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
  "nav.profile": "Profil",
  "nav.myProfile": "Ton profil",
  "nav.studio": "Studio",

  // Page d'accueil — atterrissage des visiteurs anonymes (FEN-433 / AC-2)
  "home.tagline": "Une toile de pixels collaborative, en direct sur Twitch",
  "home.discover": "Découvrir les toiles",

  // Galerie home — G6 (FEN-611), rail live retiré FEN-1423
  "home.discovery.allRail": "Toutes les chaînes",

  // Canvas introuvable — visite de /{pseudo} sans canvas existant (FEN-433 / AC-3 C6)

  // Source navigateur OBS — écran canvas indisponible (FEN-1467)
  "obs.canvas.unavailable": "Canvas indisponible",

  // Auth (F1)
  "auth.signIn": "Se connecter avec Twitch",
  "auth.signOut": "Se déconnecter",
  "auth.signedInAs": "Connecté en tant que {name}",

  // Modal de valeur pré-OAuth (FEN-580 / G1 spec §4)
  "auth.modal.title": "Connecte-toi pour dessiner",
  "auth.modal.value.streamer": "Participe à la Pixel War de {streamer}.",
  "auth.modal.value.generic": "Participe à la Pixel War en direct.",
  "auth.modal.reassurance": "Redirection sécurisée vers Twitch. On ne publie rien sans toi.",
  "auth.modal.cta": "Continuer avec Twitch",
  "auth.modal.cta.redirecting": "Redirection…",

  // Language switcher (F13)
  "lang.label": "Langue",
  "lang.en": "English",
  "lang.fr": "Français",

  // Canvas / gauge (F3–F5)
  "canvas.ready": "Prêt à poser",
  "canvas.cooldown": "Prochain pixel dans {seconds}s",
  "canvas.place": "Poser un pixel",
  "canvas.erase": "Gommer",
  "canvas.palette": "Palette de couleurs",
  "canvas.color": "Couleur {index}",
  "canvas.offline": "Reconnexion…",

  // « Partager » — copie le lien public /c/:slug (FEN-304). Le retour est porté
  // par le bouton lui-même (le libellé bascule), avec une annonce lecteur
  // d'écran et un repli de copie manuelle si le presse-papier est indisponible.
  "canvas.share.label": "Partager",
  "canvas.share.copied": "Lien copié !",
  "canvas.share.error": "Copie impossible — copiez le lien manuellement",
  "canvas.share.aria": "Partager ce canvas (copier le lien)",

  // État unifié « puis-je poser ? » (UX Lot E, FEN-117) — un seul indicateur,
  // oui/non + pourquoi + quand, un libellé texte par état (C6, jamais la couleur seule).
  "canvas.state.loading": "La fresque arrive…",
  "canvas.state.ready": "Prêt à poser",
  "canvas.state.ready.one": "Prêt à poser",
  // Pas de {seconds} ici : le décompte par seconde est porté par la ligne Lot F
  // (canvas.cooldown.*), orientée futur. Cette ligne rang-1 reste statique → un
  // lecteur d'écran l'entend une fois, pas à chaque tic (FEN-165, finding 1+2).
  // « recharge en cours » retiré : porté par la ligne Lot F (FEN-782, D2).
  "canvas.state.cooldown": "Plus de pixels",
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

  // Retour de pose sur la toile (F4) — pose/gomme optimiste + rollback (FEN-60)
  "canvas.feedback.banned": "Tu es banni de cette toile",
  "canvas.feedback.outOfBounds": "Ce pixel est hors de la toile",
  "canvas.feedback.invalidColor": "Choisis une couleur de la palette",
  "canvas.feedback.rateLimited": "Doucement — réessaie dans un instant",
  "canvas.feedback.frozen": "La toile est gelée par la modération — réessaie plus tard",
  "canvas.feedback.signInRequired": "Connecte-toi avec Twitch pour poser des pixels",
  "canvas.feedback.error": "Impossible de poser ce pixel — réessaie",
  "canvas.feedback.badRequest": "Message non reconnu — recharge la page",
  // Fermeture explicite du toast — en plus de l'auto-dismiss (FEN-329 / AC-11).
  "canvas.toast.close": "Fermer",

  // G4 — Bascule son (FEN-639) : AC4 défaut OFF (SOUND_DEFAULT), AC6 libellés a11y.
  "canvas.sound.toggle": "Activer/couper les sons",
  "canvas.sound.on": "Son activé",
  "canvas.sound.off": "Son coupé",
  "canvas.sound.blocked": "Son bloqué par le navigateur",

  // Pose en lot : modèle « sélection → validation » (FEN-113, raffinements FEN-124)
  "canvas.draw": "Dessiner",
  "canvas.placeHere": "Poser ici",
  // CTA persistant désactivé quand la réserve est vide (FEN-338 / maquette
  // « Recharge » : le bouton « Poser » devient « Attends la recharge »).
  "canvas.poseWait": "Attends la recharge",
  // P5 (FEN-1986): guidance d'état vide — aucun pixel sélectionné en mode dessin.
  "canvas.drawEmptyHint": "Touchez le canvas pour poser un pixel",
  // G5 — Jauge héroïque desktop (FEN-633). Roll-up, compte à rebours, badge Plein.
  "canvas.herogauge.label": "Charge : {charges}/{max}",
  "canvas.herogauge.charging": "+{step} dans {seconds}s",
  "canvas.herogauge.full": "Plein",
  "canvas.herogauge.empty": "Vide — recharge en cours",

  "canvas.validate": "Poser {count} pixels",
  "canvas.cancel": "Annuler",
  "canvas.finish": "Terminer",
  "canvas.drawingMode": "Mode dessin",
  "canvas.batchCount": "{count}/{max} sélectionnées",
  // Panneau d'info pixel — refonte « clic → infos → Dessiner → Confirmer » (FEN-249).
  // Un clic ouvre ce panneau (coordonnées + auteur du pixel) et n'entre JAMAIS en
  // mode sélection ; « Dessiner » démarre la sélection, « Confirmer » pose.
  "canvas.pixelInfo.title": "Informations du pixel",
  "canvas.pixelInfo.coords": "Coordonnées : {x}, {y}",
  "canvas.pixelInfo.authorLabel": "Posé par",
  "canvas.pixelInfo.authorKnown": "{login}",
  // Case vide → coordonnées + « aucun auteur » (critère : pas une erreur).
  "canvas.pixelInfo.authorEmpty": "Aucun pixel ici pour l'instant",
  "canvas.pixelInfo.authorLoading": "Chargement…",
  // Attribution résolue à rien = pixel posé sans compte. LivePlace autorise la
  // pose anonyme (canvas anonyme avant le login Twitch du 2026-06-04), donc c'est
  // le cas normal, pas une erreur. Phrase autoportante (le label « Posé par » est
  // masqué dans cet état, cf. CanvasView) → ne pas évoquer un bug (FEN-332).
  "canvas.pixelInfo.authorUnknown": "Posé anonymement",

  // Panneau de modération au clic-pixel (FEN-754 §8.2) — trois actions inline
  // réservées au propriétaire / modérateurs. Chacune est en deux temps : l'action
  // arme une ligne de confirmation, la confirmation l'exécute. Destructif, donc
  // formulation explicite.
  "canvas.mod.title": "Modération",
  "canvas.mod.deleteGroup": "Supprimer les pixels",
  "canvas.mod.ban": "Bannir l'utilisateur",
  "canvas.mod.confirm": "Confirmer",
  "canvas.mod.confirmDeleteGroup": "Effacer tout le lot posé simultanément par cet auteur ? L'historique est conservé.",
  "canvas.mod.confirmBan": "Bannir {login} de ce canevas et retirer ses pixels ?",
  "canvas.mod.confirmBanAnon": "Bannir cet auteur de ce canevas et retirer ses pixels ?",
  "canvas.mod.working": "Action en cours…",
  "canvas.mod.groupDeleted": "{count} pixels effacés",
  "canvas.mod.banned": "Auteur banni — {count} pixels retirés",
  "canvas.mod.noAuthor": "Aucun auteur à cibler ici",
  "canvas.mod.failed": "Action de modération échouée — réessaie",

  // Cooldown actif — transformer l'attente en anticipation (UX Lot F, FEN-119).
  // Décompte orienté futur : viser/armer sa prochaine case pendant la recharge,
  // puis la poser en un geste à 0:00. Pas de « skip cooldown » — on vise en avance.
  "canvas.armHere": "Viser pour la recharge",
  "canvas.cooldown.armed": "Prochaine case prête — pose à la recharge",

  // Pose au clavier + annonces lecteur d'écran (FEN-123, WCAG 2.1.1 / 4.1.3)
  "canvas.canvasLabel": "Canevas de pixels",
  "canvas.keyboardHelp":
    "Utilise les flèches pour naviguer, maintiens Maj pour aller plus vite. Espace pour sélectionner une case, Entrée pour valider, Échap pour annuler. E=gomme, I=pipette, G=grille. Maintiens Espace et bouge pour peindre en continu.",
  "canvas.cursorAt": "Case {x}, {y}",
  "canvas.cursorAtStaged": "Case {x}, {y}, sélectionnée",
  "canvas.eyedropper.active": "Pipette — cliquez pour choisir une couleur",
  "canvas.eyedropper.picked": "Couleur {index} sélectionnée",
  "canvas.eyedropper.empty": "Pixel vide",

  // Claim de palier — progression de la jauge (Lot D / FEN-116). Jauge seule ; aucun point/boutique.
  "canvas.claim.available": "Jauge +1 !",
  "canvas.claim.stacked": "{count} paliers à encaisser",
  "canvas.claim.action": "Agrandir ma jauge",
  "canvas.claim.actionOne": "Agrandir ma jauge (+1)",
  "canvas.claim.all": "Tout encaisser ({count})",

  // Panneau ouvert/fermé (R2 FEN-370 AC-R2-1/4)
  "canvas.panel.label": "Panneau du canvas",
  // Contrôles de zoom (R2 FEN-370 AC-R2-3)
  "canvas.zoom.label": "Zoom",
  "canvas.zoom.in": "Zoomer",
  "canvas.zoom.out": "Dézoomer",
  "canvas.zoom.fit": "Voir toute la fresque",

  // Menu déroulant de la topbar (mobile/compact) — regroupe les actions
  // secondaires derrière une seule affordance pour ne pas occuper une bande
  // permanente sur téléphone (AC-6).
  "canvas.menu.open": "Plus",
  "canvas.menu.studio": "Studio",

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
  "profile.empty": "Aucune toile rejointe pour l'instant.",
  "profile.myCanvas": "Mon canvas",

  // Galerie publique (F12) — consommée par GalleryPage / galleryView
  "gallery.title": "Découvrir les toiles",
  "gallery.status.live": "En live",
  "gallery.status.offline": "Hors ligne",
  "gallery.onCanvas": "{count} personnes sur le canva",
  "gallery.empty": "Aucune toile publique en direct pour le moment.",
  "gallery.viewStreamer": "Voir le profil de {name}",
  "gallery.emptyCanvas": "Canvas vide",

  // Espace streamer (F9/F10/F11) — tableau de bord / création / diffuser (FEN-120)
  "studio.title": "Studio",
  "studio.new": "Nouveau canvas",
  "studio.signInPrompt": "Connecte-toi avec Twitch pour créer et gérer tes canvas.",
  "studio.empty.title": "Aucun canvas pour l'instant",
  "studio.empty.body": "Crée-en un pour peindre en direct avec ton chat.",
  "studio.empty.cta": "Créer ton premier canvas",
  "studio.noActive.body": "Aucun de tes canvas n'est actif pour l'instant — crée-en un nouveau ou réactive une archive ci-dessous.",
  "studio.active.label": "Actif",
  "studio.status.open": "Pose ouverte",
  "studio.status.frozen": "Pose en pause",
  "studio.visibility.public": "Public",
  "studio.visibility.private": "Privé",
  "studio.action.openCanvas": "Ouvrir le canvas",
  "studio.announce.activated": "« {title} » est maintenant ton canvas actif.",
  "studio.archives.archivedOn": "archivé le {date}",
  "studio.archives.reactivateConfirm": "« {active} » passera hors ligne et « {next} » deviendra ton canvas actif. Continuer ?",
  "studio.create.title": "Nouveau canvas",
  "studio.create.nameLabel": "Nom du canvas",
  "studio.create.namePlaceholder": "ex. Neon City",
  "studio.create.nameHint": "Laisse vide pour un nom par défaut.",
  "studio.create.submit": "Créer",
  "studio.create.creating": "Création…",
  "studio.create.advanced": "Options (défauts pré-remplis)",
  "studio.create.sizeLabel": "Taille",
  "studio.create.publicLabel": "Afficher dans la galerie publique",
  "studio.create.publicHint": "Désactivé : non listé — visible seulement via le lien.",
  "studio.create.nameTooLong": "Le nom doit faire 80 caractères ou moins.",
  "studio.create.errorNameTaken": "Ce nom est déjà pris — essaie-en un autre.",
  "studio.create.error": "Impossible de créer le canvas — réessaie.",
  "studio.create.back": "Retour au tableau de bord",
  "studio.size.xs": "Minuscule (10×10)",
  "studio.size.xs.hint": "10×10 : très petit, une œuvre collective minute.",
  "studio.size.s": "Petit (20×20)",
  "studio.size.s.hint": "Petit et concentré — parfait pour une communauté soudée.",
  "studio.size.m": "Moyen (50×50)",
  "studio.size.m.hint": "Intime et très lisible — le juste milieu.",
  "studio.size.l": "Grand (100×100)",
  "studio.size.l.hint": "De la place pour une grosse foule, mais moins lisible de près.",
  "studio.broadcast.urlLabel": "URL pour OBS (source navigateur)",
  "studio.broadcast.copy": "Copier",
  "studio.broadcast.copied": "Copié !",
  "studio.broadcast.copyManual": "Copie automatique impossible — l'URL est sélectionnée, fais Ctrl/⌘+C.",

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

  // Raccourcis clavier — bottom sheet dédiée (FEN-1884)
  "canvas.shortcuts.title": "Raccourcis clavier",
  "canvas.shortcuts.triggerLabel": "Raccourcis clavier",
  "canvas.shortcuts.key.esc": "Échap",
  "canvas.shortcuts.key.enter": "Entrée",
  "canvas.shortcuts.key.space": "Espace",
  "canvas.shortcuts.role.esc": "Fermer",
  "canvas.shortcuts.role.enter.draw": "Dessiner",
  "canvas.shortcuts.role.enter.validate": "Valider",
  "canvas.shortcuts.role.e": "Gomme",
  "canvas.shortcuts.role.i": "Pipette",
  "canvas.shortcuts.role.g": "Grille",
  "canvas.shortcuts.role.space": "Peinture continue",

  // Desktop R2 layout (FEN-1052) — topbar + rail tokens
  "canvas.status.open": "Ouvert",

  // G9 — écrans état vide/erreur/404 (FEN-622)
  "state.404.title": "Cette case est vide",
  "state.404.sub": "La page que tu cherches n'existe pas (ou plus).",
  "state.404.cta1": "Retour à l'accueil",
  "state.404.cta2": "Voir la galerie",
  "state.error.kicker": "Erreur",
  "state.error.title": "Oups, un pixel a sauté",
  "state.error.sub": "Quelque chose a planté de notre côté. Réessaie.",
  "state.error.cta1": "Réessayer",
  "state.error.cta2": "Retour à l'accueil",
  "state.canvas.kicker": "Canvas",
  "state.canvas.title": "Ce canvas a disparu",
  "state.canvas.sub": "Il est peut-être privé ou supprimé.",
  "state.canvas.cta1": "Voir les chaînes en live",
  "state.canvas.cta2": "Retour à l'accueil",
  "state.emptyGallery.kicker": "Galerie",
  "state.emptyGallery.title": "Galerie vide pour l'instant",
  "state.emptyGallery.sub": "Les oeuvres terminées apparaîtront ici.",
  "state.emptyGallery.cta1": "Découvrir les chaînes en live",
  "state.offline.title": "Reconnexion…",
  "state.offline.reload": "Recharger",
  "state.offline.failed": "Connexion instable",

  // Config canvas actif (FEN-1177 · S5 · Contrat E) + refonte FEN-1356
  "studio.config.nameLabel": "Nom du canvas",
  "studio.config.sizeLabel": "Taille",
  // Modal de confirmation de réduction (FEN-1798 · C-D)
  "studio.config.resizeConfirm": "Réduire à {width}×{height} supprimera {count} pixel(s) hors cadre. Continuer ?",
  "studio.config.resize.confirmButton": "Confirmer la réduction",
  "studio.config.save": "Enregistrer",
  "studio.config.saving": "Enregistrement…",
  "studio.config.saved": "Enregistré.",
  "studio.config.error": "Impossible d'enregistrer — réessaie.",
  "studio.config.section.activeCanvas": "Canvas actif",
  "studio.config.visibility.label": "Visibilité",
  "studio.config.visibility.public": "Public",
  "studio.config.visibility.private": "Privé",
  "studio.config.canvases.title": "Mes canvas",
  "studio.config.canvases.activate": "Définir comme actif",
  "studio.crisis.section.title": "Contrôles d'urgence",

  // Moderators section (FEN-1375)
  "studio.moderators.section.title": "Modérateurs",
  "studio.moderators.empty": "Aucun modérateur — resynchronise pour importer depuis Twitch.",
  "studio.moderators.registeredYes": "sur LivePlace",
  "studio.moderators.registeredNo": "pas encore inscrit",
  "studio.moderators.resync": "Resynchroniser",
  "studio.moderators.resyncing": "Synchronisation…",
  "studio.moderators.resyncSuccess": "{active} modérateur(s) synchronisé(s).",
  "studio.moderators.resyncError": "Synchronisation échouée — réessaie.",
  "studio.moderators.resyncErrorScope": "Reconnecte ton compte Twitch — l'autorisation moderation:read est manquante.",
  "studio.moderators.resyncErrorToken": "Session Twitch expirée — reconnecte-toi via le menu de profil.",

  // Generic
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.loadMore": "Voir plus",
};
