# Contract — Claim de palier (Lot D / FEN-116)

Status: **Client mechanic implemented + unit-tested (apps/web `tierClaim.ts`,
13 cases). Server reframe IMPLEMENTED (Dev Backend, FEN-130): Convex
`points.getMyTierProgress` + `points.claimTier` (idempotent by index, no spend),
the tier curve in `lib/pointsRules.ts` (unit-tested), the atomic charge grant
`grant.lua` + gateway `/internal/gauge/claim` seam that pushes a `gauge` frame.
Remaining: wiring `TierSource` → `useQuery`/mutation in the web client (Dev
Full-stack; the `tierClaim.ts` seam is already in place).**
Consumers: web CanvasView (Dev Frontend, FEN-116). Producers: Convex `points.ts`
(Dev Backend reframe). Spec: FEN-83 ux-spec §V2.2 (board decision, Alexis
2026-06-03) + impl-breakdown Lot D. Supersedes the *spend* model in
[points-gauge-upgrade.md](./points-gauge-upgrade.md) for the **viewer-facing**
gauge upgrade.

## Model (board-locked)

The viewer sees **only their gauge (réserve)** — no points, no shop. Playing
accrues `pointsEarned` (unchanged, leaderboard-only, in coulisse). Crossing a
**tier threshold** of `pointsEarned` makes a **claim available**; the viewer
**encashes** it with an explicit, celebrated gesture → permanent **+1 max** (and,
by board default, **+1 immediately-usable charge**). Claims are **never
auto-applied**, **persistent**, **stackable**, and applied **idempotently by tier
index**.

## What the client needs (Dev Backend to provide)

Two monotonic counters per (user, canvas), plus an idempotent claim mutation.

### Query — `getMyTierProgress({ canvasId }) → { earned, confirmed }`

- `earned` (number, monotonic): tiers unlocked by play = how many `pointsEarned`
  thresholds the user has crossed. Derived server-side from the existing cost
  curve (`pointsRules.ts`): tier *n* is earned once `pointsEarned ≥ Σ_{i=1..n}
  baseUpgradeCost·i` (cumulative), capped at `gaugeMaxBonusCap`. (Exact threshold
  curve is a server product decision; the client only consumes the counter.)
- `confirmed` (number, monotonic, ≤ `earned`): tiers already applied to the gauge
  max = the current `gaugeMaxBonus`.

Should be a **live subscription** (Convex `useQuery`) so a confirmed claim shrinks
the client's optimistic overlay; the gateway must also push a `gauge` frame with
the new `max` so the WS-side gauge updates in step.

### Mutation — `claimTier({ canvasId, tierIndex }) → { gaugeMaxBonus }`

- **Idempotent by `(canvas, user, tierIndex)`**: applying the same `tierIndex`
  twice is a no-op (a reconnect may replay it — see `TierClaim.resendUnconfirmed`).
- Refuses `tierIndex > earned` (can't encash an unearned tier) and
  `tierIndex ≤ confirmed` is a safe no-op (already applied).
- On first application of a tier: `gaugeMaxBonus += 1`; by board default also
  grant **+1 usable charge** to the live gauge (gateway/Redis) so the celebration
  is actionable mid-cooldown. *(Economy tunable — board default = +1 max & +1
  charge.)*
- **No spendable `points` balance** is debited — this replaces
  `purchaseGaugeUpgrade`'s spend with a threshold claim. `pointsEarned` is left
  untouched (leaderboard).

## Client guarantees (already implemented — `apps/web/.../tierClaim.ts`)

- Tracks `cursor ∈ [confirmed, earned]`; `pending = earned − cursor` (stackable
  signal); `optimisticBonus = cursor − confirmed` (overlay on max + charges).
- `claimNext()` / `claimAll()` advance the cursor and emit `{ tierIndex }` ops;
  never auto-applies (gesture-only).
- `resendUnconfirmed()` replays `(confirmed, cursor]` indices after reconnect —
  safe because the mutation is idempotent by index.
- `sync()` is monotonic-guarded: a stale/out-of-order snapshot never rolls back.
- The displayed max/charges grow optimistically on claim and fold back
  **continuously** when the confirming `gauge` frame + `confirmed` bump land
  together (no visible jump).

The client wires this through a `TierSource` seam (`subscribe` + `claim`); until
the backend lands it defaults to an inert source, so the claim UI degrades
gracefully (simply hidden).
