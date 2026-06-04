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
  "nav.primary": "Main navigation",
  "nav.skipToContent": "Skip to content",
  "nav.canvas": "Canvas",
  "nav.gallery": "Gallery",
  "nav.leaderboard": "Leaderboard",
  "nav.profile": "Profile",
  "nav.myProfile": "Your profile",
  "nav.studio": "Studio",

  // 404 (FEN-114)
  "notFound.title": "Page not found",
  "notFound.body": "This page doesn't exist or has moved.",
  "notFound.backToCanvas": "Back to the canvas",

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

  // Canvas placement feedback (F4) — optimistic pose/erase rollback (FEN-60)
  "canvas.feedback.cooldown": "On cooldown — next pixel in {seconds}s",
  "canvas.feedback.banned": "You are banned from this canvas",
  "canvas.feedback.outOfBounds": "That pixel is off the canvas",
  "canvas.feedback.invalidColor": "Pick a colour from the palette",
  "canvas.feedback.rateLimited": "Slow down — try again in a moment",
  "canvas.feedback.signInRequired": "Sign in with Twitch to place pixels",
  "canvas.feedback.error": "Couldn't place that pixel — try again",
  "canvas.feedback.capReached": "Gauge full ({max}) — confirm or remove a pixel",
  "canvas.feedback.placed": "✓ {count} placed",
  "canvas.feedback.updated": "✓ {count} updated",

  // Batch pose: "selection → validation" model (FEN-113, refinements FEN-124)
  "canvas.draw": "Draw",
  "canvas.placeHere": "Place here",
  "canvas.validate": "Confirm {count}",
  "canvas.cancel": "Cancel",
  "canvas.finish": "Done",
  "canvas.drawingMode": "Drawing mode",
  "canvas.batchCount": "{count}/{max} selected",
  "canvas.batchHint": "Select a cell, then Confirm",
  "canvas.zoomHint": "Zoom in to place precisely",

  // Keyboard pose + screen-reader announcements (FEN-123, WCAG 2.1.1 / 4.1.3)
  "canvas.canvasLabel": "Pixel canvas",
  "canvas.keyboardHelp":
    "Use the arrow keys to aim a cell, hold Shift to move faster. Press Enter or Space to select, minus and plus to zoom, Escape to clear, and Ctrl+Enter to confirm.",
  "canvas.cursorAt": "Cell {x}, {y}",
  "canvas.cursorAtStaged": "Cell {x}, {y}, selected",

  // Claim de palier — reserve progression (Lot D / FEN-116). Gauge only; no points/shop.
  "canvas.claim.available": "Reserve +1 unlocked!",
  "canvas.claim.stacked": "{count} reserve upgrades to claim",
  "canvas.claim.action": "Grow my reserve",
  "canvas.claim.actionOne": "Grow my reserve (+1)",
  "canvas.claim.all": "Claim all ({count})",
  "canvas.claim.celebrate": "Reserve grown — {max} pixels!",

  // Adaptive just-in-time onboarding (FEN-118) — contextual, non-blocking hints
  "canvas.onboarding.arrival": "Drop pixels on the live canvas — give it a try!",
  "canvas.onboarding.aim": "Aim at a cell, pick a colour",
  "canvas.onboarding.firstPixel": "Placed! Your pixels are limited — they refill over time",
  "canvas.onboarding.gaugeEmpty": "Out of pixels — refills in {seconds}s. Line up your next cell",
  "canvas.onboarding.pointsThreshold": "+1 to your max reserve — your gauge grows as you play",
  "canvas.onboarding.help": "Need a hand?",
  "canvas.onboarding.howto": "How it works",
  "canvas.onboarding.dismiss": "Got it",

  // Public profile (F11) — consumed by ProfilePage / profileView
  // `profile.notFound` is the heading; `.body`/`.cta` form the 404-equivalent
  // recovery affordance (FEN-125).
  "profile.notFound": "Profile not found",
  "profile.notFound.body": "We couldn't find a player with that name — they may have changed it, or it never existed.",
  "profile.notFound.cta": "Discover canvases",
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
  "gallery.emptyCta": "Open the live canvas",
  "gallery.viewStreamer": "View {name}'s profile",

  // Streamer studio (F9/F10/F11) — dashboard / create / broadcast (FEN-120)
  "studio.title": "My canvases",
  "studio.new": "New canvas",
  "studio.signInPrompt": "Sign in with Twitch to create and manage your canvases.",
  "studio.empty.title": "No canvas yet",
  "studio.empty.body": "Create one to start painting live with your viewers.",
  "studio.empty.cta": "Create your first canvas",
  "studio.active.label": "Live now",
  "studio.active.dimensions": "{width}×{height} grid",
  "studio.status.open": "Placement open",
  "studio.status.frozen": "Placement frozen",
  "studio.visibility.public": "Public",
  "studio.visibility.private": "Private",
  "studio.action.broadcast": "Broadcast (OBS)",
  "studio.action.config": "Configure",
  "studio.action.openCanvas": "Open canvas",
  "studio.action.freeze": "Freeze placement",
  "studio.action.unfreeze": "Reopen placement",
  "studio.archives.title": "Archives (read-only)",
  "studio.archives.empty": "No archived canvases yet.",
  "studio.archives.archivedOn": "archived {date}",
  "studio.archives.reactivate": "Make active",
  "studio.create.title": "New canvas",
  "studio.create.nameLabel": "Canvas name",
  "studio.create.namePlaceholder": "e.g. Neon City",
  "studio.create.nameHint": "Leave blank to use a default name.",
  "studio.create.submit": "Create",
  "studio.create.creating": "Creating…",
  "studio.create.advanced": "Options (defaults filled in)",
  "studio.create.sizeLabel": "Size",
  "studio.create.paletteLabel": "Palette",
  "studio.create.paletteDefault": "Default palette",
  "studio.create.publicLabel": "List in the public gallery",
  "studio.create.publicHint": "Off keeps it unlisted — only people with the link can find it.",
  "studio.create.nameTooLong": "Name must be 80 characters or fewer.",
  "studio.create.errorNameTaken": "That name is already taken — try another.",
  "studio.create.error": "Couldn't create the canvas — try again.",
  "studio.create.back": "Back to dashboard",
  "studio.size.small": "Small (50×50)",
  "studio.size.small.hint": "Cozy and very readable — great for a focused crowd.",
  "studio.size.medium": "Medium (100×100)",
  "studio.size.medium.hint": "Balanced — the recommended default.",
  "studio.size.large": "Large (250×250)",
  "studio.size.large.hint": "Room for a big crowd, but harder to read up close.",
  "studio.broadcast.title": "Broadcast in your stream",
  "studio.broadcast.subtitle": "Add this as a Browser source in OBS — under 2 minutes.",
  "studio.broadcast.urlLabel": "OBS browser-source URL",
  "studio.broadcast.copy": "Copy",
  "studio.broadcast.copied": "Copied!",
  "studio.broadcast.step1": "Add a “Browser” source in OBS.",
  "studio.broadcast.step2": "Paste this URL into it.",
  "studio.broadcast.step3": "Resize it to fit your scene.",
  "studio.broadcast.checklist": "You should see your canvas appear.",
  "studio.broadcast.preview": "Open the OBS view in a new tab",
  "studio.broadcast.advanced": "Advanced OBS settings (background, grid, zoom…)",
  "studio.broadcast.advancedBody": "Append URL options like ?bg=000000&grid=1&zoom=8 to frame the overlay.",
  "studio.broadcast.notFound": "That canvas doesn't exist or isn't yours.",
  "studio.broadcast.back": "Back to dashboard",

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
