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
  "nav.canvas": "Toile",
  "nav.gallery": "Galerie",
  "nav.leaderboard": "Classement",
  "nav.profile": "Profil",

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

  // Generic
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.retry": "Réessayer",
  "common.loadMore": "Voir plus",
};
