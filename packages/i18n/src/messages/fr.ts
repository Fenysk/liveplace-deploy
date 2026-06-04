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
  "nav.primary": "Principale",
  "nav.canvas": "Toile",
  "nav.gallery": "Galerie",
  "nav.leaderboard": "Classement",
  "nav.profile": "Profil",
  "nav.myProfile": "Ton profil",

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

  // Pose au clavier + annonces lecteur d'écran (FEN-123, WCAG 2.1.1 / 4.1.3)
  "canvas.canvasLabel": "Canevas de pixels",
  "canvas.keyboardHelp":
    "Utilise les flèches pour viser une case, maintiens Maj pour aller plus vite. Entrée ou Espace pour sélectionner, moins et plus pour zoomer, Échap pour effacer, et Ctrl+Entrée pour valider.",
  "canvas.cursorAt": "Case {x}, {y}",
  "canvas.cursorAtStaged": "Case {x}, {y}, sélectionnée",

  // Public profile (F11) — consumed by ProfilePage / profileView
  "profile.notFound": "Profil introuvable",
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
  "gallery.viewStreamer": "Voir le profil de {name}",

  // Generic
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.retry": "Réessayer",
  "common.loadMore": "Voir plus",
};
