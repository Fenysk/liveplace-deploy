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
  "nav.openCanvasOf": "Open {name}'s canvas",
  "nav.studio": "Studio",

  // 404 (FEN-114)
  "notFound.title": "Page not found",
  "notFound.body": "This page doesn't exist or has moved.",
  "notFound.backToCanvas": "Back to the canvas",

  // Home page — landing for anonymous visitors (FEN-433 / AC-2)
  "home.tagline": "A collaborative pixel canvas, live on Twitch",
  "home.cta": "Sign in with Twitch to start",
  "home.discover": "Discover canvases",

  // Home gallery — G6 (FEN-611), live rail removed FEN-1423
  "home.discovery.allRail": "All channels",

  // Canvas not found — user visited /{pseudo} but no canvas exists (FEN-433 / AC-3 C6)
  "canvas.notFound.title": "Canvas not found",
  "canvas.notFound.body": "This canvas doesn't exist yet.",
  "canvas.notFound.cta": "Discover canvases",

  // OBS browser-source — canvas unavailable screen (FEN-1467)
  "obs.canvas.unavailable": "Canvas unavailable",

  // Auth (F1)
  "auth.signIn": "Sign in with Twitch",
  "auth.signOut": "Sign out",
  "auth.signedInAs": "Signed in as {name}",

  // Auth error toast — OAuth cancellation / failure (FEN-1474)
  "auth.error.cancelled": "Sign-in cancelled",
  "auth.error.failed": "Couldn't sign in — try again",

  // Pre-OAuth value modal (FEN-580 / G1 spec §4)
  "auth.modal.title": "Sign in to draw",
  "auth.modal.value.streamer": "Join {streamer}'s Pixel War.",
  "auth.modal.value.generic": "Join the live Pixel War.",
  "auth.modal.reassurance": "Secure redirect to Twitch. We never post on your behalf.",
  "auth.modal.cta": "Continue with Twitch",
  "auth.modal.cta.redirecting": "Redirecting…",
  "auth.modal.close": "Close",

  // Language switcher (F13)
  "lang.label": "Language",
  "lang.en": "English",
  "lang.fr": "Français",

  // Canvas / gauge (F3–F5)
  "canvas.ready": "Ready to place",
  "canvas.cooldown": "Next pixel in {seconds}s",
  "canvas.place": "Place pixel",
  "canvas.erase": "Erase",
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
  // "refilling" dropped: owned by the Lot F line (FEN-782, D2).
  "canvas.state.cooldown": "No more pixels",
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
  "canvas.feedback.banned": "You are banned from this canvas",
  "canvas.feedback.outOfBounds": "That pixel is off the canvas",
  "canvas.feedback.invalidColor": "Pick a colour from the palette",
  "canvas.feedback.rateLimited": "Slow down — try again in a moment",
  "canvas.feedback.frozen": "The canvas is frozen by moderation — try again later",
  "canvas.feedback.signInRequired": "Sign in with Twitch to place pixels",
  "canvas.feedback.error": "Couldn't place that pixel — try again",
  "canvas.feedback.badRequest": "Unrecognized message — reload the page",
  "canvas.feedback.capReached": "Gauge full ({max}) — confirm or remove a pixel",
  // Explicit toast dismiss — alongside the auto-dismiss (FEN-329 / AC-11).
  "canvas.toast.close": "Dismiss",

  // G4 — Sound toggle (FEN-639): AC4 default OFF (SOUND_DEFAULT), AC6 a11y labels.
  "canvas.sound.toggle": "Toggle sounds",
  "canvas.sound.on": "Sound on",
  "canvas.sound.off": "Sound off",
  "canvas.sound.blocked": "Sound blocked by the browser",

  // Batch pose: "selection → validation" model (FEN-113, refinements FEN-124)
  "canvas.draw": "Draw",
  "canvas.placeHere": "Place here",
  // Persistent CTA disabled while the reserve is empty (FEN-338 / maquette
  // "Recharge": the "Place" button becomes "Wait for the recharge").
  "canvas.poseWait": "Wait for the recharge",
  // G5 — Heroic desktop gauge (FEN-633). Roll-up, countdown, Full badge.
  "canvas.herogauge.label": "Charge: {charges}/{max}",
  "canvas.herogauge.charging": "+{step} in {seconds}s",
  "canvas.herogauge.full": "Full",
  "canvas.herogauge.empty": "Empty — charging",
  // canvas.gauge.hero.* = feature-level expressive card (canvas/HeroGauge.tsx, FEN-611).
  "canvas.gauge.hero.label": "Charge",
  "canvas.gauge.hero.aria": "Charge: {charges}/{max}",
  "canvas.gauge.hero.charging": "+{step} in {seconds}s",
  "canvas.gauge.hero.full": "Full",
  "canvas.gauge.hero.empty": "Empty — charging",

  "canvas.pose.fab.disabled": "Hold on…",
  "canvas.validate": "Place {count} pixels",
  "canvas.cancel": "Cancel",
  "canvas.finish": "Done",
  "canvas.drawingMode": "Drawing mode",
  "canvas.batchCount": "{count}/{max} selected",
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

  // Pixel-click moderation panel (FEN-754 §8.2) — three inline actions shown only
  // to the canvas owner / moderators. Each is two-tap: the action arms an inline
  // confirm row, the confirm runs it. Destructive, so the wording is explicit.
  "canvas.mod.title": "Moderation",
  "canvas.mod.deletePixel": "Delete pixel",
  "canvas.mod.deleteGroup": "Erase group",
  "canvas.mod.ban": "Ban author",
  "canvas.mod.confirm": "Confirm",
  "canvas.mod.confirmDeletePixel": "Remove this pixel from the canvas? The history is kept.",
  "canvas.mod.confirmDeleteGroup": "Erase the whole batch this author placed together? The history is kept.",
  "canvas.mod.confirmBan": "Ban {login} from this canvas and remove their pixels?",
  "canvas.mod.confirmBanAnon": "Ban this author from this canvas and remove their pixels?",
  "canvas.mod.working": "Working…",
  "canvas.mod.pixelDeleted": "Pixel removed",
  "canvas.mod.groupDeleted": "{count} pixels erased",
  "canvas.mod.banned": "Author banned — {count} pixels removed",
  "canvas.mod.noAuthor": "No author to target here",
  "canvas.mod.failed": "Moderation action failed — try again",

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
    "Use the arrow keys to navigate, hold Shift to move faster. Press Space to select a cell, Enter to confirm, Escape to cancel. E=eraser, I=eyedropper, G=grid, M=pan. Hold Space and move to paint continuously.",
  "canvas.cursorAt": "Cell {x}, {y}",
  "canvas.cursorAtStaged": "Cell {x}, {y}, selected",

  // Claim de palier — gauge progression (Lot D / FEN-116). Gauge only; no points/shop.
  "canvas.claim.available": "Gauge +1 unlocked!",
  "canvas.claim.stacked": "{count} gauge upgrades to claim",
  "canvas.claim.action": "Grow my gauge",
  "canvas.claim.actionOne": "Grow my gauge (+1)",
  "canvas.claim.all": "Claim all ({count})",

  // Celebration moment (Arcade Lot D, FEN-272) — the non-blocking delight that
  // springs over the canvas at a milestone. Title shows in the Press Start face.
  "celebration.firstPixel.title": "First pixel!",
  "celebration.firstPixel.message": "You're on the canvas. Keep going!",
  "celebration.tier.title": "Reserve grown!",
  "celebration.tier.message": "{max} pixels ready — paint bigger.",
  "celebration.milestone.title": "{count} pixels!",
  "celebration.milestone.message": "Your mark is spreading.",

  // Adaptive just-in-time onboarding (FEN-118) — contextual, non-blocking hints
  "canvas.onboarding.howto": "How it works",
  // Manual “?” recall — the core entry gesture, moved out of the permanent dock
  // strip (FEN-329 / anchor §3) so it is read on demand, not always on screen.
  "canvas.onboarding.recall": "Click a pixel to inspect it; press Draw to start placing.",
  // G2 guided onboarding gate — porte 2-temps (FEN-584 §5)
  "canvas.onboarding.welcome.title": "{streamer}'s Pixel War",
  "canvas.onboarding.welcome.body": "Drop pixels with the community, live. Quick tour? ~30s.",
  "canvas.onboarding.welcome.start": "Let's go",
  "canvas.onboarding.welcome.skip": "Skip",
  "canvas.onboarding.tools.title": "How to place",
  "canvas.onboarding.tools.desktop": "Click a cell to select it, then Validate. Chain a few if you like.",
  "canvas.onboarding.tools.mobile": "Tap Draw, select your cells, then Validate.",
  "canvas.onboarding.tools.colour": "Pick your colour from the palette.",
  "canvas.onboarding.tools.cta": "Place my first pixel",
  "canvas.onboarding.step": "Step {n}/{total}",
  "canvas.onboarding.skip.title": "Skip the tour?",
  "canvas.onboarding.skip.body": "You can replay it anytime from \u201cHow it works\u201d.",
  "canvas.onboarding.skip.confirm": "Skip",
  "canvas.onboarding.skip.cancel": "Keep the tour",


  // Panel open/close (R2 FEN-370 AC-R2-1/4). The dock becomes a closeable
  // overlay: PanelHandle + explicit ✕ close + ZoomControls.
  "canvas.panel.label": "Canvas panel",
  "canvas.panel.close": "Reduce panel",
  "canvas.panel.open": "Open panel",
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
  "canvas.menu.studio": "Studio / Pilot",

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

  // Streamer studio (F9/F10/F11) — dashboard / create (FEN-120)
  "studio.title": "Studio",
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
  "studio.broadcast.urlLabel": "OBS browser-source URL",
  "studio.broadcast.copy": "Copy",
  "studio.broadcast.copied": "Copied!",
  "studio.broadcast.copyManual": "Couldn't copy automatically — the URL is selected, press Ctrl/⌘+C.",

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

  // Keyboard shortcuts cheat-sheet (G8 FEN-615) — discoverable via icon button
  // or "?" key; lists every canvas shortcut with FR/EN copy from the spec.
  "canvas.shortcuts.title": "Keyboard shortcuts",
  "canvas.shortcuts.open": "Keyboard shortcuts",
  "canvas.shortcuts.close": "Close",
  "canvas.shortcuts.esc": "Esc — Cancel / close",
  "canvas.shortcuts.enter": "Enter — Confirm",
  "canvas.shortcuts.e": "E — Eraser",
  "canvas.shortcuts.i": "I — Eyedropper",
  "canvas.shortcuts.g": "G — Grid",
  "canvas.shortcuts.m": "M — Pan",
  "canvas.shortcuts.space": "Space (hold) — Continuous paint",
  "canvas.shortcuts.question": "? — This help",
  "canvas.shortcuts.tip": "Tip: hold Space to paint continuously.",

  // Desktop R2 layout (FEN-1052) — topbar + rail tokens
  "canvas.status.open": "Open",

  // G9 — empty / error / 404 state screens (FEN-622)
  "state.404.kicker": "404",
  "state.404.title": "This cell is empty",
  "state.404.sub": "The page you're looking for doesn't exist (anymore).",
  "state.404.cta1": "Back to home",
  "state.404.cta2": "Browse the gallery",
  "state.error.kicker": "Error",
  "state.error.title": "Oops, a pixel slipped",
  "state.error.sub": "Something broke on our side. Please try again.",
  "state.error.cta1": "Try again",
  "state.error.cta2": "Back to home",
  "state.error.details": "Technical details",
  "state.canvas.kicker": "Canvas",
  "state.canvas.title": "This canvas is gone",
  "state.canvas.sub": "It may be private or deleted.",
  "state.canvas.cta1": "See live channels",
  "state.canvas.cta2": "Back to home",
  "state.emptyList.kicker": "Live",
  "state.emptyList.title": "Nobody's painting… yet",
  "state.emptyList.sub": "Be the first to start a canvas.",
  "state.emptyList.cta1": "Browse the gallery",
  "state.emptyList.cta2": "Back to home",
  "state.emptyGallery.kicker": "Gallery",
  "state.emptyGallery.title": "Gallery's empty for now",
  "state.emptyGallery.sub": "Finished artworks will show up here.",
  "state.emptyGallery.cta1": "Discover live channels",
  "state.offline.title": "Reconnecting…",
  "state.offline.sub": "You're momentarily disconnected from the live feed.",
  "state.offline.reload": "Reload",
  "state.offline.failed": "Unstable connection",

  // Studio panel shell (FEN-1173)
  "studio.panel.close": "Close panel",

  // Config canvas actif (FEN-1177 · S5 · Contrat E) + refonte FEN-1356
  "studio.config.nameLabel": "Canvas name",
  "studio.config.sizeLabel": "Size",
  "studio.config.sizeReadOnly": "Size: {width}×{height} (fixed — canvas already has pixels)",
  "studio.config.save": "Save",
  "studio.config.saving": "Saving…",
  "studio.config.saved": "Saved.",
  "studio.config.error": "Couldn't save — try again.",
  "studio.config.section.resume": "Overview",
  "studio.config.section.settings": "Settings",
  "studio.config.visibility.label": "Visibility",
  "studio.config.visibility.public": "Public",
  "studio.config.visibility.private": "Private",
  "studio.config.canvases.title": "Canvases",
  "studio.config.canvases.activate": "Make active",
  "studio.crisis.section.title": "Emergency controls",

  // Moderators section (FEN-1375)
  "studio.moderators.section.title": "Moderators",
  "studio.moderators.empty": "No moderators yet — resync to import from Twitch.",
  "studio.moderators.registeredYes": "on LivePlace",
  "studio.moderators.registeredNo": "not yet registered",
  "studio.moderators.resync": "Resync from Twitch",
  "studio.moderators.resyncing": "Syncing…",
  "studio.moderators.resyncSuccess": "{active} moderator(s) synced.",
  "studio.moderators.resyncError": "Sync failed — try again.",

  // Post-login redirect (FEN-1472 / S2 case B)
  "auth.postLogin.noCanvas": "Your canvas isn't ready yet — check back in a moment.",

  // Generic
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.retry": "Retry",
  "common.loadMore": "Load more",
  "common.close": "Close",
} as const satisfies Record<string, string>;

/** Union of every valid message key, derived from the English catalog. */
export type MessageKey = keyof typeof en;

/** Shape every locale catalog must satisfy (same keys as English). */
export type Catalog = Record<MessageKey, string>;
