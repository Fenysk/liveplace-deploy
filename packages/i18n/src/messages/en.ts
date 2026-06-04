/**
 * English catalog — the SOURCE OF TRUTH for message keys.
 *
 * Every other locale catalog is typed as {@link Catalog} (derived from this
 * object), so the compiler rejects any locale that is missing a key or adds an
 * unknown one. To add a string: add it here first, then to every other catalog.
 *
 * Keys are flat, dot-namespaced (`area.thing`). Placeholders use `{name}` and
 * are filled at render time — see `format.ts`.
 */
export const en = {
  // App shell
  "app.title": "LivePlace",
  "app.tagline": "A collaborative pixel canvas, live on Twitch",

  // Navigation
  "nav.canvas": "Canvas",
  "nav.gallery": "Gallery",
  "nav.leaderboard": "Leaderboard",
  "nav.profile": "Profile",

  // Auth (F1)
  "auth.signIn": "Sign in with Twitch",
  "auth.signOut": "Sign out",
  "auth.signedInAs": "Signed in as {name}",

  // Language switcher (F13)
  "lang.label": "Language",
  "lang.en": "English",
  "lang.fr": "Français",

  // Canvas / gauge (F3–F5)
  "canvas.ready": "Ready to place",
  "canvas.cooldown": "Next pixel in {seconds}s",
  "canvas.place": "Place pixel",
  "canvas.erase": "Erase",
  "canvas.gauge": "{current}/{max} pixels",
  "canvas.palette": "Colour palette",
  "canvas.viewers": "{count} watching",
  "canvas.connecting": "Connecting…",
  "canvas.offline": "Reconnecting…",

  // Unified "can I place?" state (UX Lot E, FEN-117) — one indicator,
  // yes/no + why + when, a text label for every state (C6, never colour alone).
  "canvas.state.loading": "Loading the canvas…",
  "canvas.state.ready": "You can place — {charges} pixels ready",
  // Singular variant (charges === 1) — derivePlaceState picks the key (R2, FEN-138).
  "canvas.state.ready.one": "You can place — 1 pixel ready",
  "canvas.state.cooldown": "Out of pixels — refills in {seconds}s",
  "canvas.state.signedOut": "Sign in with Twitch to place",
  "canvas.state.frozen": "Placing is paused",
  // "notStarted" disambiguates the open day so the user can plan their return (R1,
  // FEN-138): same-day keeps just the time; tomorrow/other carry the day too.
  "canvas.state.notStarted": "Opens at {time}",
  "canvas.state.notStarted.tomorrow": "Opens tomorrow at {time}",
  "canvas.state.notStarted.date": "Opens {date} at {time}",
  "canvas.state.ended": "This event has ended",
  "canvas.state.archived": "Finished canvas — view only",
  "canvas.state.banned": "You can no longer place on this canvas",
  "canvas.state.notFound": "This canvas can't be found",

  // Canvas placement feedback (F4) — optimistic pose/erase rollback (FEN-60)
  "canvas.feedback.cooldown": "On cooldown — next pixel in {seconds}s",
  "canvas.feedback.banned": "You are banned from this canvas",
  "canvas.feedback.outOfBounds": "That pixel is off the canvas",
  "canvas.feedback.invalidColor": "Pick a colour from the palette",
  "canvas.feedback.rateLimited": "Slow down — try again in a moment",
  "canvas.feedback.signInRequired": "Sign in with Twitch to place pixels",
  "canvas.feedback.error": "Couldn't place that pixel — try again",
  "canvas.feedback.capReached": "Gauge full ({max}) — confirm or remove a pixel",

  // Batch pose: "selection → validation" model (FEN-113)
  "canvas.draw": "Draw",
  "canvas.validate": "Confirm {count}",
  "canvas.cancel": "Cancel",
  "canvas.batchCount": "{count}/{max} selected",
  "canvas.batchHint": "Tap a cell to select, then Confirm",

  // Public profile (F11) — consumed by ProfilePage / profileView
  "profile.notFound": "Profile not found",
  "profile.memberSince": "Member since {date}",
  "profile.totals": "Totals",
  "profile.pixelsPlaced": "Pixels placed",
  "profile.points": "Points",
  "profile.canvasesJoined": "Canvases joined",
  "profile.canvas": "Canvas",
  "profile.bestRank": "Best rank",
  "profile.rank": "#{rank}",
  "profile.empty": "No canvases joined yet.",

  // Public gallery (F12) — consumed by GalleryPage / galleryView
  "gallery.title": "Discover canvases",
  "gallery.viewers": "{count} watching",
  "gallery.empty": "No public canvases live right now.",

  // Generic
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.retry": "Retry",
  "common.loadMore": "Load more",
} as const satisfies Record<string, string>;

/** Union of every valid message key, derived from the English catalog. */
export type MessageKey = keyof typeof en;

/** Shape every locale catalog must satisfy (same keys as English). */
export type Catalog = Record<MessageKey, string>;
