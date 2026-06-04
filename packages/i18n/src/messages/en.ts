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

  // Viewer legibility of moderation events (UX Lot I, FEN-121) — "a collective
  // event happened" without jargon or anxiety (D8 row, lisibilité only, zero
  // viewer feature). Sourced from a server-initiated bulk change / freeze toggle.
  "canvas.moderation.areaChanged": "An area was just changed",
  "canvas.moderation.paused": "Placing was just paused",
  "canvas.moderation.reopened": "Placing is open again",

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

  // Active cooldown — turn the wait into anticipation (UX Lot F, FEN-119).
  // Forward-oriented countdown: aim/arm the next cell while it refills, then
  // drop it in one gesture at refill. No "skip cooldown" — you only aim ahead.
  "canvas.armHere": "Aim for refill",
  "canvas.cooldown.waiting": "Aim your next pixel while it refills — {seconds}s",
  "canvas.cooldown.armed": "Next pixel ready — drops in {seconds}s",
  "canvas.cooldown.ready": "Refilled — confirm to drop your pixel",

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
  "canvas.onboarding.pointsThreshold": "You earned reserve — tap “Grow my reserve” to claim it and enlarge your gauge",
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
  "studio.noActive.body": "None of your canvases is active right now — create a new one or reactivate an archive below.",
  "studio.active.label": "Active",
  "studio.active.dimensions": "{width}×{height} grid",
  "studio.status.open": "Placement open",
  "studio.status.frozen": "Placement frozen",
  "studio.visibility.public": "Public",
  "studio.visibility.private": "Private",
  "studio.action.broadcast": "Broadcast (OBS)",
  "studio.action.openCanvas": "Open canvas",
  "studio.action.freeze": "Freeze placement",
  "studio.action.unfreeze": "Reopen placement",
  "studio.announce.frozen": "Placement frozen.",
  "studio.announce.reopened": "Placement reopened.",
  "studio.announce.activated": "“{title}” is now your active canvas.",
  "studio.archives.title": "Archives (read-only)",
  "studio.archives.empty": "No archived canvases yet.",
  "studio.archives.archivedOn": "archived {date}",
  "studio.archives.reactivate": "Make active",
  "studio.archives.reactivateConfirm": "“{active}” will go offline and “{next}” will become your active canvas. Continue?",
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
  "studio.broadcast.copyManual": "Couldn't copy automatically — the URL is selected, press Ctrl/⌘+C.",
  "studio.broadcast.step1": "Add a “Browser” source in OBS.",
  "studio.broadcast.step2": "Paste this URL into it.",
  "studio.broadcast.step3": "Resize it to fit your scene.",
  "studio.broadcast.checklist": "You should see your canvas appear.",
  "studio.broadcast.preview": "Open the OBS view in a new tab",
  "studio.broadcast.advanced": "Advanced OBS settings (background, grid, zoom…)",
  "studio.broadcast.advancedBody": "Append URL options like ?bg=000000&grid=1&zoom=8 to frame the overlay.",
  "studio.broadcast.notFound": "That canvas doesn't exist or isn't yours.",
  "studio.broadcast.back": "Back to dashboard",

  // Streamer crisis panel (UX Lot I, FEN-121) — react to a raid without panic
  // (D6 Flow S3 / WF-8). Freeze is the always-present 1-gesture panic control;
  // ban/wipe are grouped triage tools surfaced only once frozen.
  "studio.crisis.status.calm": "Placement open — emergency freeze ready",
  "studio.crisis.status.frozen": "Placement frozen — act, then reopen",
  "studio.crisis.freeze": "Freeze placing",
  "studio.crisis.reopen": "Reopen placing",
  "studio.crisis.ban": "Ban an author",
  "studio.crisis.wipe": "Wipe an area",
  "studio.crisis.restore": "Undo this wipe",
  "studio.crisis.wipeWarning": "Erasing re-reveals what was underneath.",
  "studio.crisis.firstHint": "If things go wrong, freeze placing here.",
  "studio.crisis.banPrompt": "Pick the author to ban on the canvas.",
  "studio.crisis.wipePrompt": "Pick the area to wipe on the canvas.",
  "studio.crisis.announce.frozen": "Placement frozen — crisis tools are now available.",
  "studio.crisis.announce.reopened": "Placement reopened.",

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
