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

  // Home page — landing for anonymous visitors (FEN-433 / AC-2)
  "home.tagline": "A collaborative pixel canvas, live on Twitch",
  "home.cta": "Sign in with Twitch to start",
  "home.discover": "Discover canvases",

  // Canvas not found — user visited /{pseudo} but no canvas exists (FEN-433 / AC-3 C6)
  "canvas.notFound.title": "Canvas not found",
  "canvas.notFound.body": "This canvas doesn't exist yet.",
  "canvas.notFound.cta": "Discover canvases",

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
  "canvas.gauge": "Gauge: {current}/{max}",
  "canvas.nextPixel": "Next pixel",
  // Bounded reserve (ReserveMeter, FEN-338) — the compact counter that fixes
  // overflow défaut #1: one number + a capped bar, never a row of N squares.
  // Same width at N=20 and N=40.
  "canvas.reserve.ready": "pixels ready",
  "canvas.reserve.cap": "/ {cap}",
  "canvas.reserve.full": "reserve full",
  "canvas.palette": "Colour palette",
  // Palette header in the dock (FEN-338) — small section label.
  "canvas.palette.heading": "Colour",
  "canvas.color": "Colour {index}",
  "canvas.viewers": "{count} watching",
  "canvas.connecting": "Connecting…",
  "canvas.offline": "Reconnecting…",

  // "Partager" — copy the public /c/:slug link (FEN-304). Feedback is on the
  // button itself (label flips), with a screen-reader announcement and a manual
  // fallback when the clipboard is unavailable.
  "canvas.share.label": "Share",
  "canvas.share.copied": "Link copied!",
  "canvas.share.error": "Couldn't copy — copy the link manually",
  "canvas.share.aria": "Share this canvas (copy the link)",

  // Unified "can I place?" state (UX Lot E, FEN-117) — one indicator,
  // yes/no + why + when, a text label for every state (C6, never colour alone).
  "canvas.state.loading": "Loading the canvas…",
  "canvas.state.ready": "Ready to place",
  // Singular variant (charges === 1) — derivePlaceState picks the key (R2, FEN-138).
  "canvas.state.ready.one": "Ready to place",
  // No {seconds} here: the per-second countdown is owned by the forward-framed
  // Lot F line (canvas.cooldown.*), so this rang-1 permission line stays static
  // and a screen reader hears it once, not every tick (FEN-165, finding 1+2).
  "canvas.state.cooldown": "Gauge: 0/{max} — refilling",
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
  "canvas.feedback.cooldown": "On cooldown — gauge refilling",
  "canvas.feedback.banned": "You are banned from this canvas",
  "canvas.feedback.outOfBounds": "That pixel is off the canvas",
  "canvas.feedback.invalidColor": "Pick a colour from the palette",
  "canvas.feedback.rateLimited": "Slow down — try again in a moment",
  "canvas.feedback.signInRequired": "Sign in with Twitch to place pixels",
  "canvas.feedback.error": "Couldn't place that pixel — try again",
  "canvas.feedback.capReached": "Gauge full ({max}) — confirm or remove a pixel",
  // Explicit toast dismiss — alongside the auto-dismiss (FEN-329 / AC-11).
  "canvas.toast.close": "Dismiss",

  // Batch pose: "selection → validation" model (FEN-113, refinements FEN-124)
  "canvas.draw": "Draw",
  "canvas.placeHere": "Place here",
  // Persistent CTA disabled while the reserve is empty (FEN-338 / maquette
  // "Recharge": the "Place" button becomes "Wait for the recharge").
  "canvas.poseWait": "Wait for the recharge",
  "canvas.validate": "Place {count} pixels",
  "canvas.cancel": "Cancel",
  "canvas.finish": "Done",
  "canvas.drawingMode": "Drawing mode",
  "canvas.batchCount": "{count}/{max} selected",
  "canvas.batchHint": "Select a cell, then Confirm",

  // Pixel-info panel — refonte "clic → infos → Dessiner → Confirmer" (FEN-249).
  // A click opens this panel (coordinates + who placed the pixel) and never
  // enters selection mode; "Draw" starts selection, "Confirm" commits the pose.
  "canvas.pixelInfo.title": "Pixel info",
  "canvas.pixelInfo.coords": "Coordinates: {x}, {y}",
  "canvas.pixelInfo.authorLabel": "Placed by",
  "canvas.pixelInfo.authorKnown": "{login}",
  // Empty cell → coordinates + "no author" (acceptance: not an error).
  "canvas.pixelInfo.authorEmpty": "No pixel here yet",
  "canvas.pixelInfo.authorLoading": "Loading…",
  // Lookup resolved to nothing = pixel placed without an account. LivePlace
  // allows anonymous placement (anonymous canvas predates the 2026-06-04 Twitch
  // login), so this is the normal case, not an error. Self-contained phrase (the
  // "Placed by" label is hidden in this state, see CanvasView) → no bug vibe (FEN-332).
  "canvas.pixelInfo.authorUnknown": "Placed anonymously",
  "canvas.pixelInfo.close": "Close",

  // Active cooldown — turn the wait into anticipation (UX Lot F, FEN-119).
  // Forward-oriented countdown: aim/arm the next cell while it refills, then
  // drop it in one gesture at refill. No "skip cooldown" — you only aim ahead.
  "canvas.armHere": "Aim for refill",
  // Phase strings carry NO {seconds}: the ticking value is rendered in a separate
  // aria-hidden span (canvas.cooldown.seconds) so the live region announces each
  // phase transition once, not every second (FEN-165 finding 1). The visible
  // per-second countdown stays for sighted users.
  "canvas.cooldown.waiting": "Aim your next pixel while it refills",
  "canvas.cooldown.armed": "Next pixel armed — drops at refill",
  "canvas.cooldown.ready": "Refilled — confirm to drop your pixel",
  // Visible-only ticking counter, mirrored into an aria-hidden span (FEN-165).
  "canvas.cooldown.seconds": "{seconds}s",

  // Keyboard pose + screen-reader announcements (FEN-123, WCAG 2.1.1 / 4.1.3)
  "canvas.canvasLabel": "Pixel canvas",
  "canvas.keyboardHelp":
    "Use the arrow keys to aim a cell, hold Shift to move faster. Press Enter or Space to select, minus and plus to zoom, Escape to clear, and Ctrl+Enter to confirm.",
  "canvas.cursorAt": "Cell {x}, {y}",
  "canvas.cursorAtStaged": "Cell {x}, {y}, selected",

  // Claim de palier — gauge progression (Lot D / FEN-116). Gauge only; no points/shop.
  "canvas.claim.available": "Gauge +1 unlocked!",
  "canvas.claim.stacked": "{count} gauge upgrades to claim",
  "canvas.claim.action": "Grow my gauge",
  "canvas.claim.actionOne": "Grow my gauge (+1)",
  "canvas.claim.all": "Claim all ({count})",
  "canvas.claim.celebrate": "Gauge grown — {max} pixels!",

  // Celebration moment (Arcade Lot D, FEN-272) — the non-blocking delight that
  // springs over the canvas at a milestone. Title shows in the Press Start face.
  "celebration.firstPixel.title": "First pixel!",
  "celebration.firstPixel.message": "You're on the canvas. Keep going!",
  "celebration.tier.title": "Reserve grown!",
  "celebration.tier.message": "{max} pixels ready — paint bigger.",
  "celebration.milestone.title": "{count} pixels!",
  "celebration.milestone.message": "Your mark is spreading.",

  // Adaptive just-in-time onboarding (FEN-118) — contextual, non-blocking hints
  "canvas.onboarding.arrival": "Drop pixels on the live canvas — give it a try!",
  "canvas.onboarding.aim": "Aim at a cell, pick a colour",
  "canvas.onboarding.firstPixel": "Placed! Your pixels are limited — they refill over time",
  "canvas.onboarding.gaugeEmpty": "Line up your next cell while the gauge refills",
  "canvas.onboarding.pointsThreshold": "You earned gauge — tap “Grow my gauge” to claim it",
  "canvas.onboarding.help": "Need a hand?",
  "canvas.onboarding.howto": "How it works",
  // Manual "?" recall — the core entry gesture, moved out of the permanent dock
  // strip (FEN-329 / anchor §3) so it is read on demand, not always on screen.
  "canvas.onboarding.recall": "Click a pixel to inspect it; press Draw to start placing.",
  "canvas.onboarding.dismiss": "Got it",

  // Panel open/close (R2 FEN-370 AC-R2-1/4). The dock becomes a closeable
  // overlay: PanelHandle + explicit ✕ close + ReopenFab + ZoomControls.
  "canvas.panel.label": "Canvas panel",
  "canvas.panel.close": "Reduce panel",
  "canvas.panel.open": "Open panel",
  // ReopenFab badge labels
  "canvas.panel.fabTier": "Open panel — a reserve upgrade is ready",
  "canvas.panel.fabStaged": "Open panel — {count} pixel{count,plural,one{} other{s}} in progress",
  // SR announcement when the panel state changes (polite, once)
  "canvas.panel.announced.closed": "Panel closed",
  "canvas.panel.announced.opened": "Panel opened",
  // ZoomControls (R2 FEN-370 AC-R2-3)
  "canvas.zoom.label": "Zoom",
  "canvas.zoom.in": "Zoom in",
  "canvas.zoom.out": "Zoom out",
  "canvas.zoom.fit": "See the whole canvas",

  // Topbar overflow menu (mobile/compact) — groups the secondary actions behind a
  // single affordance so they don't eat a permanent strip on a phone (AC-6).
  "canvas.menu.open": "More",
  "canvas.menu.close": "Close menu",

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

  // Crisis ban/wipe/restore selection surfaces (FEN-160 / spec FEN-157 §5).
  "studio.crisis.ban.mode": "Ban mode — pick one of the author's pixels",
  "studio.crisis.ban.empty": "No author's pixel here — pick a coloured pixel.",
  "studio.crisis.ban.confirm": "Ban {author} and remove all their pixels?",
  "studio.crisis.ban.confirmCount": "{count} pixels will be removed.",
  "studio.crisis.ban.protected": "You can't ban a moderator or the owner.",
  "studio.crisis.ban.success": "Author banned — {count} pixels removed.",
  "studio.crisis.ban.successPending": "Author banned — pixel removal pending (stream not connected).",
  "studio.crisis.ban.error": "Ban not applied — try again.",
  "studio.crisis.ban.anonAuthor": "this author",
  "studio.crisis.wipe.mode": "Wipe mode — outline an area",
  "studio.crisis.wipe.count": "Area: {count} cells",
  "studio.crisis.wipe.empty": "Select at least one cell.",
  "studio.crisis.wipe.confirm": "Wipe {count} cells? What was underneath reappears.",
  "studio.crisis.wipe.large": "Large area ({count} cells) — confirm the wipe.",
  "studio.crisis.wipe.success": "{count} cells wiped.",
  "studio.crisis.wipe.successPending": "Wipe recorded — removal pending (stream not connected).",
  "studio.crisis.wipe.error": "Wipe not applied — try again.",
  "studio.crisis.cancel": "Cancel",
  "studio.crisis.cancelled": "Cancelled.",
  "studio.crisis.history.title": "Recent actions",
  "studio.crisis.history.empty": "No recent actions.",
  "studio.crisis.history.error": "History unavailable — try again.",
  "studio.crisis.history.wipeRow": "Wipe — {count} cells",
  "studio.crisis.history.banRow": "Ban of {author} — {count} pixels",
  "studio.crisis.history.restored": "Restored",
  "studio.crisis.restore.confirm": "Restore {count} pixels? Recent placements on those cells will be overwritten.",
  "studio.crisis.restore.success": "{count} pixels restored.",

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
