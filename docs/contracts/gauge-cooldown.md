# Contract — Gauge / cooldown (A4) — the server→client jauge contract

Status: **FROZEN (rev 1, 2026-06-17).** This is the chantier **A4** deliverable of
the backbone refonte ([FEN-607](/FEN/issues/FEN-607), proposition-refonte §3.2).
Owner: Founding Engineer. Primary consumer: the **héroïque gauge UI / cooldown
engagement** UX gate **G5** (Vague 2, [FEN-606](/FEN/issues/FEN-606)) and the
onboarding **G2**. Freezing it is what lets G5 be launched without the UI having
to guess events, timings, or what "plein" means.

> **Why a dedicated contract doc.** The numeric mechanics (token-bucket refill)
> already exist and are unit-tested in `@canvas/redis-scripts` (`gauge.ts` mirrored
> by `place.lua`), and the wire types live in `@canvas/protocol`. What did **not**
> exist was a single, frozen description of *what the UI receives, when, and how to
> read it*. This doc is that surface. It adds **no** new wire fields — it ratifies
> the existing ones (PROTOCOL_VERSION stays 1).

This contract governs **decision D1** (Product Owner: gauge mechanics) on the wire.
It does **not** re-decide D1 numbers; it pins how D1 state reaches the client.

---

## 1. Mental model (one paragraph)

The jauge is a **per-(user, canvas) token bucket**. A viewer holds up to `max`
charges and regenerates `refillAmount` charge every `refillIntervalMs`. Every
placement (coloured **or** eraser) costs exactly **1** charge. The bucket is
authoritative **server-side in Redis** (atomic Lua, `place.lua`); the client never
owns the truth — it **renders** the gauge the server reports and **may predict**
the smooth countdown between frames using the shared pure math. "Cooldown" is not a
separate timer: it is simply the state `charges === 0`, and the UI counts down to
the moment the next charge lands.

---

## 2. D1 timings & defaults (the numbers the UI may assume)

Canvas-level config, owner-overridable later; these are the deployed defaults
(`@canvas/redis-scripts` `DEFAULT_GAUGE`, mirrored in `place.lua`).

| Param               | Default   | Meaning                                                        |
| ------------------- | --------- | ------------------------------------------------------------- |
| `gaugeMaxBase`      | **20**    | charges of burst reserve before any upgrade bonus              |
| `refillAmount`      | **1**     | charges granted per refill tick                                |
| `refillIntervalMs`  | **30 000**| one tick = 1 charge / 30 s in steady state                    |
| init                | **full**  | a viewer's **first** placement on a canvas starts at `max`     |
| eraser (color 0)    | costs **1**| an erase consumes a charge like a colour                      |

**Effective `max` = `gaugeMaxBase` + per-user upgrade bonus (F6).** The client must
**never hard-code 20** — it reads `max` from the gauge frames below. A points
upgrade (`purchaseGaugeUpgrade`, F6) raises `max`; the gateway pushes a fresh
`gauge` frame so the new ceiling appears within the session.

> The client **must not** hard-code `refillIntervalMs` either if it can avoid it;
> it can derive the countdown purely from `cooldownUntil` (§4). The interval is
> documented here only so the UI can render a *progress* arc (elapsed/interval)
> if it wants one. If a canvas overrides D1, the arc denominator should come from a
> future `welcome` field — flagged as a non-breaking additive extension, not in v1.

---

## 3. The wire — `GaugeState` and the frames that carry it

Authoritative types: `@canvas/protocol` (`PROTOCOL_VERSION = 1`). All control
frames are JSON text frames.

```ts
interface GaugeState {
  charges: number;       // charges available RIGHT NOW (post lazy-refill), 0..max
  max: number;           // effective maximum = base + upgrade bonus (F6)
  cooldownUntil: number; // epoch ms the NEXT charge lands; 0 when the gauge is FULL
}
```

### 3.1 Frames that carry the gauge (server → client)

| Frame                 | When the gateway sends it                                                                 | Carries           |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `welcome`             | once, on connect after auth. Carries `cooldownUntil` + `seq` (snapshot follows).          | `cooldownUntil`†  |
| `ack` + `GaugeState`  | the sender's **own** placement was accepted. `cid` echoes the `place` op id (FEN-63).     | full `GaugeState` |
| `gauge` + `GaugeState`| **unsolicited refresh**: a passive refill tick, or an upgrade that raised the ceiling.     | full `GaugeState` |
| `error{code}` (+`cid`)| a placement was **rejected**. `code:"cooldown"` ⇒ empty gauge; client rolls back its cid. | `code` only‡      |

† `welcome` carries `cooldownUntil` but **not** `charges`/`max` directly; the client
should treat the first `gauge`/`ack` it receives as the authoritative initial gauge,
or request a refresh. The gateway emits an initial `gauge` frame right after
`welcome` so the héroïque gauge has real `charges`/`max` to render immediately (the
"initial-gauge" fix, FEN-184/FEN-267 regression guard — a missing initial `gauge`
is the historical "canvas reçoit gauge mais reste Loading" bug).

‡ `error{code:"cooldown"}` does **not** carry a fresh `GaugeState` (the placement was
refused, nothing consumed). The UI already knows it is on cooldown from the last
`ack`/`gauge`; the error just rolls back the optimistic pixel for that `cid`. There
is also a legacy `cooldown{until}` frame (deprecated) — treat `until` identically to
`GaugeState.cooldownUntil`.

### 3.2 Frames the client sends (client → server)

| Frame                                | Meaning                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `place{x,y,color,cid?}`              | request a placement; gauge-gated. `cid` = opaque op id (echo + CA5 dedup) |
| `ping` / `resync{seq}`               | keepalive / reconnect catch-up (see ws backbone, ADR-0003)               |

The client **must not** send `place` while it believes `charges === 0` — but the
server is the authority and will answer `error{code:"cooldown"}` defensively if it
does. Arming (pre-aiming the next cell during cooldown) is a **client-only** UX
affordance (see `apps/web/.../cooldown.ts`); it sends no frame until a charge lands.

---

## 4. The "plein" (full) state — the part G5 must get exactly right

There is **one** definition of full, and the UI must key on the gauge frame, never
on a local timer:

```
isFull  ⇔  charges === max        (equivalently the server sends cooldownUntil === 0)
onCooldown ⇔ charges === 0        (the arming window; commit is gated)
```

Rules the server guarantees (so the UI can rely on them):

1. **`cooldownUntil === 0` ⇔ the gauge is full.** When full, regeneration is
   *paused* — the refill clock is pinned to `now`, so the first charge after the
   next consume is a **full** `refillIntervalMs` away (no early arrival from
   leftover elapsed time). The héroïque gauge should render "plein / max" with **no
   running countdown** in this state.
2. **`0 < charges < max` ⇒ `cooldownUntil > now`** and a charge is pending. The UI
   shows `charges/max` filled and a live countdown to the next charge.
3. **`charges === 0` ⇒ on cooldown**, `cooldownUntil` is when the next (the *only*
   currently spendable) charge lands. Commit is gated; arming is allowed.

### 4.1 Deriving the display (pure, no server round-trip)

```ts
fillRatio        = charges / max                      // 0..1 for the héroïque fill
secondsUntilNext = max(0, ceil((cooldownUntil - now) / 1000))   // 0 when full
isFull           = charges === max                    // ⇔ cooldownUntil === 0
canPlace         = charges > 0                         // see derivePlaceState (Lot E)
```

`now` is the client clock. Small skew is tolerable for a countdown; the **truth**
arrives in the next `ack`/`gauge`. For a continuously smooth bar between frames the
client may re-run the shared pure refill (`@canvas/redis-scripts` `refillGauge` /
`nextRefillAt`) with the D1 params above — it is the *same algorithm the server
runs*, so prediction never disagrees with the next authoritative frame by more than
one tick.

---

## 5. G5 consumption guide (héroïque gauge + cooldown engagement)

What the gate needs → where it comes from. This is the **traceability** to G5.

| G5 / UX need (proposition §3.2, cahier §F5)                    | Contract source                                  |
| ------------------------------------------------------------- | ------------------------------------------------ |
| Render current / max charges                                  | `GaugeState.charges`, `GaugeState.max`           |
| Héroïque fill level                                           | `charges / max` (§4.1)                           |
| Live countdown to next charge                                 | `secondsUntilNext` from `cooldownUntil` (§4.1)   |
| "Plein" celebration / steady state (no countdown)            | `charges === max` ⇔ `cooldownUntil === 0` (§4)   |
| Update on every pose without polling                          | `ack` frame (§3.1) — *the message carries the data* |
| Update on passive refill / upgrade without placing           | unsolicited `gauge` frame (§3.1)                 |
| Cooldown engagement (arm next cell, forward copy)             | `apps/web/.../cooldown.ts` over this gauge       |
| Rollback a refused pose                                       | `error{code:"cooldown", cid}` (§3.1)             |

**G5 has everything it needs from rev 1.** No new wire field is required to build
the héroïque gauge. If G5 later wants a *progress arc within a tick*, that is the
single additive follow-up (a `refillIntervalMs` field on `welcome`) called out in
§2 — non-breaking, PROTOCOL_VERSION stays 1.

---

## 6. Acceptance / traceability

Every clause traces to an existing, enforced rule:

| Clause                                  | Enforced by (source of truth)                              |
| --------------------------------------- | ---------------------------------------------------------- |
| token-bucket refill math                | `@canvas/redis-scripts/gauge.ts` `refillGauge` (unit-tested) |
| atomic refill→check→consume (no TOCTOU) | `place.lua` (single Redis round-trip) — mitigates R1       |
| effective max = base + bonus (F6)       | `points.getGaugeBonus` + `effectiveGaugeMax` (D1 §1.3 / F6 contract) |
| wire shape (`GaugeState`, frames)       | `@canvas/protocol` `PROTOCOL_VERSION = 1` (frozen)         |
| `cooldownUntil === 0 ⇔ full`            | `place.lua` returns `cd = 0` when full; `nextRefillAt` returns 0 |
| init full on first pose                 | `refillGauge(stored=null)` → `charges = max`               |
| eraser costs 1                          | `place.lua` (no colour-0 exemption)                        |
| initial `gauge` after `welcome`         | gateway send path (FEN-184/FEN-267 regression guard)       |

Verification (pure math, no Redis):

```
node --test packages/redis-scripts/test/gauge.test.ts
```

Cross-references: D1 (FEN-9 / FEN-15), F6 points/upgrade
([points-gauge-upgrade.md](points-gauge-upgrade.md)), cooldown engagement
(`apps/web/src/features/canvas/cooldown.ts`, Lot F), realtime backbone
([ADR-0003](../adr/0003-ws-gateway-topology.md)), snapshot format
([ADR-0006](../adr/0006-snapshot-format.md)), anti-patterns register
([FEN-572](/FEN/issues/FEN-572) — see AP on JSON-sparse state & per-nav refetch).
</content>
