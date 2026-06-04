/**
 * Tests for the FEN-117 unified "puis-je poser ?" state — the Definition-of-Done
 * surface for UX Lot E (the lot's "tests automatisés = DoD" verification).
 *   node --test apps/web/src/features/canvas/placeState.test.ts
 *
 * Covers the acceptance criteria:
 *   - every distinct state is reachable, distinct, and carries a TEXT label key
 *     (C6: no state relies on colour alone; impossible to "click to discover")
 *   - exactly one state (`ready`) answers yes; all others say no + why (+ when)
 *   - the backend's single `outside_event_window` is split into the two UX
 *     states the spec differentiates: notStarted (future, with a time) vs ended
 *   - precedence: the most authoritative/informative reason wins when several
 *     blocks are simultaneously true
 *   - "prévenir avant le clic": gauge-empty / not-signed-in / frozen are all
 *     surfaced pre-click, never as a post-attempt surprise
 *   - the catalogs (FR + EN) actually carry a string for every state's key
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  derivePlaceState,
  secondsUntil,
  defaultFormatTime,
  type PlaceStateInput,
  type PlaceStateKind,
} from "./placeState.ts";
import type { GaugeState } from "@canvas/protocol";
import type { MessageKey } from "@canvas/i18n";
// Import the catalogs straight from their (import-free) source files rather than
// the `@canvas/i18n` barrel: the barrel re-exports modules that use `.js`
// specifiers, which Node's `--experimental-transform-types` runner can't resolve
// (it does not rewrite `.js`→`.ts`). en.ts has no imports and fr.ts has only a
// type-only one, so both load cleanly under the same runner the repo uses.
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const NOW = 1_700_000_000_000;

const fullGauge: GaugeState = { charges: 3, max: 6, cooldownUntil: 0 };
const emptyGauge: GaugeState = { charges: 0, max: 6, cooldownUntil: NOW + 9_000 };

/** A happy-path input: connected, signed in, allowed, gauge with charges. */
function base(over: Partial<PlaceStateInput> = {}): PlaceStateInput {
  return {
    connection: "open",
    authenticated: true,
    permission: { allowed: true },
    eventStartAt: null,
    eventEndAt: null,
    gauge: fullGauge,
    now: NOW,
    formatTime: () => "14:30", // deterministic, locale-independent
    ...over,
  };
}

test("ready: allowed + signed in + connected + charges → the one yes state", () => {
  const s = derivePlaceState(base());
  assert.equal(s.kind, "ready");
  assert.equal(s.canPlace, true);
  assert.equal(s.blocking, false);
  assert.equal(s.messageKey, "canvas.state.ready");
  assert.deepEqual(s.params, { charges: 3, max: 6 });
});

test("cooldown: allowed but gauge empty → no, with a 'when' (pre-click, C2)", () => {
  const s = derivePlaceState(base({ gauge: emptyGauge }));
  assert.equal(s.kind, "cooldown");
  assert.equal(s.canPlace, false);
  assert.equal(s.messageKey, "canvas.state.cooldown");
  assert.equal(s.params?.seconds, 9);
  assert.equal(s.until, emptyGauge.cooldownUntil);
});

test("signedOut: open canvas but anonymous visitor → sign-in prompt, not a gauge", () => {
  const s = derivePlaceState(base({ authenticated: false, gauge: null }));
  assert.equal(s.kind, "signedOut");
  assert.equal(s.canPlace, false);
  assert.equal(s.messageKey, "canvas.state.signedOut");
});

test("frozen: placement_closed → temporary pause, not blocking", () => {
  const s = derivePlaceState(base({ permission: { allowed: false, reason: "placement_closed" } }));
  assert.equal(s.kind, "frozen");
  assert.equal(s.canPlace, false);
  assert.equal(s.blocking, false);
  assert.equal(s.messageKey, "canvas.state.frozen");
});

test("archived: read-only forever, even before sign-in", () => {
  const s = derivePlaceState(
    base({ authenticated: false, permission: { allowed: false, reason: "canvas_archived" } }),
  );
  assert.equal(s.kind, "archived");
  assert.equal(s.blocking, true);
  assert.equal(s.messageKey, "canvas.state.archived");
});

test("notFound: canvas_not_found surfaces as its own state", () => {
  const s = derivePlaceState(base({ permission: { allowed: false, reason: "canvas_not_found" } }));
  assert.equal(s.kind, "notFound");
  assert.equal(s.blocking, true);
  assert.equal(s.messageKey, "canvas.state.notFound");
});

test("notStarted: outside_event_window with a FUTURE start → carries the open time", () => {
  const start = NOW + 60_000;
  const s = derivePlaceState(
    base({
      permission: { allowed: false, reason: "outside_event_window" },
      eventStartAt: start,
      eventEndAt: start + 3_600_000,
      formatTime: (ms) => (ms === start ? "15:00" : "??"),
    }),
  );
  assert.equal(s.kind, "notStarted");
  assert.equal(s.messageKey, "canvas.state.notStarted");
  assert.equal(s.params?.time, "15:00");
  assert.equal(s.until, start);
  assert.equal(s.blocking, false); // it WILL open — not a dead end
});

test("ended: outside_event_window with a PAST window → terminé (distinct from notStarted)", () => {
  const s = derivePlaceState(
    base({
      permission: { allowed: false, reason: "outside_event_window" },
      eventStartAt: NOW - 7_200_000,
      eventEndAt: NOW - 3_600_000, // ended an hour ago
    }),
  );
  assert.equal(s.kind, "ended");
  assert.equal(s.messageKey, "canvas.state.ended");
  assert.equal(s.blocking, true);
});

test("notStarted vs ended are DISTINCT outcomes of the same backend reason", () => {
  const common = { permission: { allowed: false, reason: "outside_event_window" as const } };
  const future = derivePlaceState(base({ ...common, eventStartAt: NOW + 1, eventEndAt: NOW + 10 }));
  const past = derivePlaceState(base({ ...common, eventStartAt: NOW - 10, eventEndAt: NOW - 1 }));
  assert.notEqual(future.kind, past.kind);
});

test("banned (WS sticky hint): honoured even while permission still loading", () => {
  const s = derivePlaceState(base({ permission: undefined, gauge: null, bannedHint: true }));
  assert.equal(s.kind, "banned");
  assert.equal(s.blocking, true);
  assert.equal(s.messageKey, "canvas.state.banned");
});

test("banned (backend reason): mapped when canPlace returns it", () => {
  const s = derivePlaceState(base({ permission: { allowed: false, reason: "banned" } }));
  assert.equal(s.kind, "banned");
});

test("loading: permission not yet known and nothing more authoritative", () => {
  const s = derivePlaceState(base({ permission: undefined, gauge: null }));
  assert.equal(s.kind, "loading");
  assert.equal(s.canPlace, false);
  assert.equal(s.messageKey, "canvas.state.loading");
});

test("loading: connected, allowed, but gauge frame not in yet", () => {
  const s = derivePlaceState(base({ gauge: null }));
  assert.equal(s.kind, "loading");
});

test("offline: dropped after connecting → reconnecting (reuses canvas.offline)", () => {
  const s = derivePlaceState(base({ connection: "offline" }));
  assert.equal(s.kind, "offline");
  assert.equal(s.messageKey, "canvas.offline");
});

// ── Precedence: when several blocks are true, the right one wins ──────────────

test("precedence: archived outranks banned (read-only-for-all is the better message)", () => {
  const s = derivePlaceState(
    base({ bannedHint: true, permission: { allowed: false, reason: "canvas_archived" } }),
  );
  assert.equal(s.kind, "archived");
});

test("precedence: banned outranks the event window", () => {
  const s = derivePlaceState(
    base({
      bannedHint: true,
      permission: { allowed: false, reason: "outside_event_window" },
      eventStartAt: NOW + 60_000,
    }),
  );
  assert.equal(s.kind, "banned");
});

test("precedence: frozen outranks signedOut (a frozen canvas refuses everyone)", () => {
  const s = derivePlaceState(
    base({ authenticated: false, permission: { allowed: false, reason: "placement_closed" } }),
  );
  assert.equal(s.kind, "frozen");
});

test("precedence: signedOut outranks offline/cooldown (anon has no gauge)", () => {
  const s = derivePlaceState(base({ authenticated: false, connection: "offline", gauge: emptyGauge }));
  assert.equal(s.kind, "signedOut");
});

// ── Acceptance: every state distinct, labelled, and exactly one says "yes" ───

test("each state kind is reachable and exactly one (ready) answers canPlace=true", () => {
  const cases: Array<[PlaceStateKind, PlaceStateInput]> = [
    ["ready", base()],
    ["cooldown", base({ gauge: emptyGauge })],
    ["signedOut", base({ authenticated: false, gauge: null })],
    ["frozen", base({ permission: { allowed: false, reason: "placement_closed" } })],
    ["archived", base({ permission: { allowed: false, reason: "canvas_archived" } })],
    ["notFound", base({ permission: { allowed: false, reason: "canvas_not_found" } })],
    ["banned", base({ permission: { allowed: false, reason: "banned" } })],
    [
      "notStarted",
      base({ permission: { allowed: false, reason: "outside_event_window" }, eventStartAt: NOW + 10 }),
    ],
    [
      "ended",
      base({ permission: { allowed: false, reason: "outside_event_window" }, eventStartAt: NOW - 10, eventEndAt: NOW - 1 }),
    ],
    ["loading", base({ permission: undefined, gauge: null })],
    ["offline", base({ connection: "offline" })],
  ];
  const seen = new Set<PlaceStateKind>();
  let yes = 0;
  for (const [expected, input] of cases) {
    const s = derivePlaceState(input);
    assert.equal(s.kind, expected, `expected ${expected}, got ${s.kind}`);
    seen.add(s.kind);
    if (s.canPlace) yes++;
    // C6: every state has a non-empty text label key present in BOTH catalogs.
    assert.ok(s.messageKey, `${expected} has no messageKey`);
    assert.ok(en[s.messageKey as MessageKey], `EN catalog missing ${s.messageKey}`);
    assert.ok(fr[s.messageKey as MessageKey], `FR catalog missing ${s.messageKey}`);
  }
  assert.equal(seen.size, cases.length, "every state kind is distinct");
  assert.equal(yes, 1, "exactly one state answers canPlace=true");
});

test("FR/EN parity: both catalogs carry every canvas.state.* key", () => {
  const keys: MessageKey[] = [
    "canvas.state.loading",
    "canvas.state.ready",
    "canvas.state.cooldown",
    "canvas.state.signedOut",
    "canvas.state.frozen",
    "canvas.state.notStarted",
    "canvas.state.ended",
    "canvas.state.archived",
    "canvas.state.banned",
    "canvas.state.notFound",
  ];
  for (const k of keys) {
    assert.ok(en[k] && en[k].length > 0, `EN missing ${k}`);
    assert.ok(fr[k] && fr[k].length > 0, `FR missing ${k}`);
    assert.notEqual(en[k], fr[k], `${k} not actually translated`);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test("secondsUntil: ceils and floors at zero", () => {
  assert.equal(secondsUntil(NOW + 8_400, NOW), 9);
  assert.equal(secondsUntil(NOW - 1, NOW), 0);
});

test("defaultFormatTime: returns a short HH:MM-ish label for an epoch", () => {
  const out = defaultFormatTime(NOW);
  assert.match(out, /\d{1,2}[:h]?\d{2}/);
});
