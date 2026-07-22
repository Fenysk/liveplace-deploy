# ADR-0004 — Canvas dimension contract: a single 512 ceiling

- Status: **Accepted**
- Date: 2026-06-03
- Owner / decider: Founding Engineer
- Affects: FEN-95 (this decision), FEN-88 (authenticated deploy, unblocked),
  FEN-94 (anonymous seed, shipped), `packages/protocol`,
  `apps/convex/convex/lib/canvasRules.ts`, `apps/convex/convex/canvases.ts`,
  `apps/gateway`, `apps/worker`

## Context

Two frozen contracts disagreed on the canvas dimension:

- **WS/Redis hot path** — `@canvas/protocol` `CANVAS_WIDTH = CANVAS_HEIGHT = 512`.
  This is the deployed geometry: the gateway (`apps/gateway/src/config.ts`
  default), the persistence worker (rebuilds the Redis bitmap on restore from
  `getCanvasDurable`), and the binary snapshot/delta frames all assume it. The
  binary frames encode `width`/`height`/`x`/`y` as **u16**, so the structural
  ceiling is 65535.
- **F2 public-create rule** — `canvasRules.MAX_DIMENSION = 500`, enforced by
  `assertValidDimensions`, hence by the public `createCanvas` mutation.

Because `500 < 512`, in **authenticated mode** (FEN-88, `GATEWAY_AUTH_DISABLED=0`)
a real streamer calling `createCanvas` was capped at 500×500 while
gateway/Redis/worker assumed 512×512. The durable `canvases` row and the
hot-path geometry could diverge: a bitmap restored at the wrong size, and
placements valid on the 512 hot path but out of the 500 Convex bound. The
anonymous seed (FEN-94, `ensureDefaultCanvas`) sidestepped this by inserting at
512 directly (an `internalMutation`, never calling the validator) to mirror the
deploy — so the anonymous path was fine, but the authenticated path stayed
incoherent. This is a latent blocker for FEN-88.

## Decision

**Align `MAX_DIMENSION` to 512.** There is now a single dimension ceiling, 512,
shared by the protocol geometry and the F2 create rule.

Rationale for raising the rule (500 → 512) rather than lowering the protocol
(512 → 500):

- 512 is a power of two — the natural size for a canvas bitmap and for the
  1-byte/pixel Redis string the snapshot is a verbatim `GET` of (ADR-0006).
- The protocol geometry is the **deployed reality**; many surfaces already
  default to 512 (`.env.example`, gateway/worker config, the FEN-94 seed).
  Lowering to 500 would mean re-touching all of them
  and re-sizing the live deployment for no benefit.
- The cost of 512 over 500 is negligible: `MAX_CELLS` goes from 250 000 to
  262 144 cells (a 256 KiB Redis bitmap at 1 byte/pixel) — still a sane
  memory/perf bound (§9.5/§10).
- 512 stays far inside the u16 wire limit, so no protocol-version bump.

The protocol's `CANVAS_WIDTH`/`CANVAS_HEIGHT` remain the **default** deployed
geometry (tunable per the provisional-contract note in `@canvas/protocol`),
*not* a max. `MAX_DIMENSION` is the **ceiling**. They now coincide at 512, which
is the property that matters: the default deployed size is always a legal
`createCanvas` value, so the authenticated and hot-path geometries can never
diverge by construction. Clients still read width/height from the snapshot
frame, so a future geometry change stays non-breaking.

## Consequences

- `canvasRules.MAX_DIMENSION = 512`; `MAX_CELLS = 262 144`.
- The FEN-94 seed's 512 value is now within the `assertValidDimensions` bound;
  its bypass comment is updated to note the divergence is retired (it still
  inserts directly as an `internalMutation`).
- Cross-reference comments added on both sides
  (`canvasRules.MAX_DIMENSION` ↔ `protocol.CANVAS_WIDTH/HEIGHT`) so the lockstep
  is discoverable; whoever changes one must change the other.
- FEN-88 (authenticated deploy) is no longer latently blocked by this mismatch.

## Alternatives considered

- **Lower the protocol to 500.** Rejected: forces re-touching every default and
  re-sizing the live deploy; 500 is not a power of two.
- **Make geometry fully configurable and derive the rule bound from a runtime
  config.** Rejected for the MVP as over-engineering: the deploy runs a single
  fixed geometry, and a config indirection adds a moving part with no MVP payoff.
  If multi-size canvases land later, the bound can read from the protocol
  constant (or a shared config) at that point — the single-ceiling invariant
  here is forward-compatible with that.

---

## Addendum — FEN-1762: per-canvas geometry on the gateway hot path

- **Date:** 2026-07-11
- **Status:** Implemented

### Context

After FEN-1712 (FEN-1721 size picker), canvases have durable dimensions chosen
from `[10, 20, 50, 100]` stored in the Convex `canvases` table. However the
gateway still used the single global `cfg.width/height` (512×512 from the env
`CANVAS_WIDTH` default) for all of: the F2 bounds guard (`placement.ts`), the
`DeltaCoalescer` offset arithmetic (`gateway.ts`), and the snapshot
encode/decode (`readCanvasSnapshot`/`encodeSnapshot`). Any canvas whose durable
width ≠ 512 would suffer corrupted pixel offsets, wrong-sized snapshots, and
incorrect bounds rejections.

### Decision

The gateway now resolves per-canvas geometry at subscribe time via a new
lightweight Convex query (`canvases:getCanvasDimsById`) and caches it in memory
(`CanvasDimsCache` in `apps/gateway/src/canvasDims.ts`). The resolved dims are
threaded through placement bounds guard, `DeltaCoalescer` construction, and all
snapshot read/encode calls.

`cfg.width/height` (the env 512 default) **remains the fallback** when:
- Convex is not configured (local smoke / tests without a Convex deployment).
- The Convex fetch times out or returns a missing row.
- The canvas state entry is accessed before subscribe completes (should not
  happen in practice — subscribe runs before `sendInitialState`).

The 512 ceiling from the original decision is unchanged — it is now the
*fallback* geometry for the gateway, not the only geometry.

### No protocol bump

Clients already read `width`/`height` from the `welcome` snapshot frame
(ADR-0006). The gateway now sends the canvas's actual durable dims in those
fields rather than always sending 512. No client change is required.

### Source

- `apps/gateway/src/canvasDims.ts` — `CanvasDimsCache`, `CanvasDimsProvider`
- `apps/convex/convex/canvases.ts` — `getCanvasDimsById` query
- `apps/gateway/src/index.ts` — shared Convex client + `createDimsCache`
- `apps/gateway/src/gateway.ts` — `dimsCache` field, threaded through
  `canvasStates`, `sendInitialState`, `handleResync`, `moderationFor`
- `apps/gateway/src/placement.ts` — `dimsProvider` in `PlacementConfig`
