# Contract — Points & gauge-max upgrade (F6 / FEN-18)

Status: **Convex logic implemented + unit-tested; Redis hot-path application
pending the gateway-integration child issue.**
Owner: Founding Engineer. Consumers: gateway / gauge owner (F5 FEN-15, F7
FEN-13), persistence worker (FEN-17), profile (F11 FEN-22), leaderboard (F10
FEN-21). Spec: cahier §F6 + decision D1 (FEN-9).

`points` is a **cumulative progression score, distinct from the gauge**, scoped
per **(user, canvas)**. Its only MVP sink is buying permanent +1 increments to a
player's max gauge on a canvas. (Levels/XP and other sinks are out of scope —
G-P3.)

## Acceptance criteria (cahier §F6)

- **CA1** — 10 colored placements = 10 points.
- **CA2** — spending raises the **effective** max gauge.
- **CA3** — cost increases; the purchase is refused at the cap.
- **CA4** — spending without balance fails with **no partial debit**.

All four are enforced and unit-tested in the pure rules
`apps/convex/convex/lib/pointsRules.ts` (12 tests). Run:

```
node --test apps/convex/convex/lib/pointsRules.test.ts
```

## Defaults (decision D1, overridable per canvas later)

| Param              | Default | Meaning                                            |
| ------------------ | ------- | -------------------------------------------------- |
| `pointsPerPlacement` | 1     | points per colored placement (CA1)                 |
| `baseUpgradeCost`  | 50      | the n-th upgrade costs `baseUpgradeCost × n` (CA3)  |
| `gaugeMaxBonusCap` | 30      | hard cap on the purchasable bonus (CA3)            |

Cost of the next upgrade given the bonus already owned:
`baseUpgradeCost × (gaugeMaxBonus + 1)` → 50, 100, 150, … 1500 for the 30th.

## Table — `userCanvasStats` (per user, per canvas)

```ts
userCanvasStats: defineTable({
  userId: v.string(),            // Better Auth user id (§6.1)
  canvasId: v.id("canvases"),
  points: v.number(),            // SPENDABLE balance (earned − spent); CA1/CA4
  pointsEarned: v.number(),      // lifetime earned, never decremented (progression/F10)
  pixelsPlaced: v.number(),      // lifetime colored placements (F11/F10)
  gaugeMaxBonus: v.number(),     // permanent +max increments bought (0..cap) — F6 core
  bestRank: v.optional(v.number()), // best leaderboard rank, if computed (F10)
  lastPlacedAt: v.optional(v.number()),
  updatedAt: v.number(),
})
  .index("by_canvas_user", ["canvasId", "userId"])
  .index("by_user", ["userId"])           // F11 profile
  .index("by_canvas_points", ["canvasId", "points"]) // F10 leaderboard
```

This is the single per-(user, canvas) aggregate row shared by F6 / F10 / F11.
The F11 read-model (`lib/publicProfile.ts`) already expects `points` /
`pixelsPlaced` / `bestRank` on it.

## Convex functions — `apps/convex/convex/points.ts`

| Function                  | Kind             | Used by            | Notes |
| ------------------------- | ---------------- | ------------------ | ----- |
| `awardPlacementPoints`    | internalMutation | persistence worker (FEN-17) | `+count × pointsPerPlacement`; upsert. CA1. Worker owns at-least-once dedup (flushState). |
| `purchaseGaugeUpgrade`    | mutation         | web client (F6 UI) | transactional spend; CA2/CA3/CA4. Throws `PointsRuleError` (`cap_reached` / `insufficient_points`) on refusal — no write occurs. |
| `getMyCanvasStats`        | query            | web UI / profile   | the signed-in user's row (zeros if none). |
| `getGaugeBonus`           | query            | **gateway**        | `{ gaugeMaxBonus }` for (canvasId, userId) — the hot-path application contract below. |

## Hot-path application — "MAJ de la max Redis" (CA2)

**Layering:** Convex is the durable source of truth for `gaugeMaxBonus`; Redis
stays authoritative for the live token bucket. Per the repo's layering, **Convex
never writes to Redis** — the gateway/worker own Redis.

The place-pixel Lua script already takes the max as an ARGV (`maxCharges` /
`gaugeMax`). So no Lua change is required: the **gateway** computes

```
effectiveGaugeMax = canvasBaseGaugeMax + gaugeMaxBonus
```

and passes it as the script's max for that user. The gateway obtains the bonus
from `points.getGaugeBonus({ canvasId, userId })`:

- on WS connect (after auth), cache the bonus for the session, and
- after a `purchaseGaugeUpgrade` the client triggers a gateway refresh (or
  reconnects) so the new max takes effect within the session.

`effectiveGaugeMax(base, bonus)` is exported from `lib/pointsRules.ts` so the
gateway shares the exact formula. The gateway-side wiring is tracked as the
F6 gateway-integration child issue (it lives in the actively-rewritten gateway
owned by FEN-13/FEN-15, so F6 hands it the contract rather than editing that
file concurrently).
```
