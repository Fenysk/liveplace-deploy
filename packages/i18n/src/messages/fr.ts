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

  // Generic
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.retry": "Réessayer",
};
