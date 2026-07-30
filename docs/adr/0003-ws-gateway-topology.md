# ADR-0003 — Realtime backbone (D3): dedicated WS gateway + Redis pub/sub fan-out, decoupled from durable state

- Status: **Accepted** (ratifies the topology already shipped: gateway + per-canvas
  Redis hot path)
- Date: 2026-06-17
- Owner / decider: Founding Engineer (owns decision **D3** per the CEO directive)
- Affects: `apps/gateway` (the WS service), `packages/redis-scripts` (`place.lua`,
  per-canvas `canvasKeys`), `apps/worker` (durable drain), `infra/Caddyfile`
  (reverse-proxy `/ws` route), the persistence worker
  ([persistence-worker.md](../contracts/persistence-worker.md)).
- Issue: chantier **A3** of [FEN-607](/FEN/issues/FEN-607) (proposition-refonte §3.2,
  criteria C5/C6). Mitigates **R1** ([risks.md](../risks.md)). The per-canvas
  Redis stream / key schema landed in [FEN-54](/FEN/issues/FEN-54); this ADR is its
  formal record together with the gateway-topology decision.

> **Numbering note.** This single ADR is the canonical "ADR-0003" referenced across
> the codebase in **two** senses that were never two files: (a) the *dedicated WS
> gateway as a separate service* (`risks.md`, `Caddyfile`) and (b) the *per-canvas
> Redis key schema + placement stream* (`canvasKeys`, worker, `place.lua`
> comments). They are the same realtime-backbone decision and are recorded here.

## Context

A Twitch-driven canvas must push every pixel to up to 10 000+ concurrent viewers
with the pixel visible "live on stream" (R1), while a separate durable copy is kept
in Convex (R2). Two coupling traps from the old repo (`liveplace_next`,
[FEN-549](/FEN/issues/FEN-549)) must be avoided:

- **Fan-out coupled to the durable DB.** The old repo signalled realtime through a
  Postgres table (`canvas__sync_notifications`) plus polling — every live update
  touched durable storage and clients refetched. That couples read fan-out to write
  durability and does not scale to stream-sized audiences.
- **No clean catch-up.** Reconnecting clients re-pulled state rather than replaying
  only what they missed.

D3 (the CEO directive: *WS gateway — separate service vs integrated*) must decide the
topology that keeps live fan-out fast and decoupled from durable state.

## Decision

**A dedicated, stateless WS gateway service fans out via Redis pub/sub, fully
decoupled from the durable store. The message carries the data (0 refetch), and
reconnecting clients catch up from the last tick they saw.**

1. **Separate service, not integrated.** The gateway (`apps/gateway`) is its own
   process behind the reverse proxy (`/ws`, [Caddyfile](../../infra/Caddyfile)) —
   **not** folded into Convex or the web app. Rationale: it is the one component
   that must scale on *connection count* independently of app/DB load, it has a
   different runtime profile (long-lived sockets), and Convex is not a socket
   server. Integrating it would couple connection scaling to app deploys and put
   durable-store latency on the live path.

2. **Stateless & horizontally scalable.** No per-connection server state beyond the
   socket. N gateway replicas all `SUBSCRIBE` to the same per-canvas pub/sub
   channel; adding replicas adds fan-out capacity with **no sticky sessions**. This
   is the structural mitigation for R1.

3. **Fan-out decoupled from durability — two independent sinks (FEN-54).** The
   atomic hot path (`place.lua`) does, in one Redis round-trip:
   - `SETRANGE` the pixel byte (canvas string),
   - `INCR` the per-canvas monotonic `version` (= the wire `seq`),
   - **PUBLISH** an ephemeral `version,x,y,color` delta → the **realtime** sink, and
   - **XADD** the full `{x,y,color,version,userId,ts}` record to the per-canvas
     **Stream** → the **durability** sink the worker drains.
   Realtime and durability share the atomic write but are otherwise independent:
   pub/sub never waits on Convex, and a flush failure never drops a live frame.

4. **The message carries the data → 0 refetch.** A delta frame contains the pixel
   itself; clients apply it directly and never round-trip the DB for live updates
   (vs the old `sync_notifications` + refetch).

5. **Catch-up from tick T.** Every frame carries the global monotonic `seq`. On
   reconnect a client sends `resync{seq}`; the gateway replays buffered writes with
   `seq >` that value, or answers `resyncRequired` + a fresh snapshot if the
   request aged out. A live socket delivers in TCP order, so gaps can only happen
   across a disconnect — one per-frame `seq` is sufficient to detect and repair.

6. **Per-canvas key namespace.** All hot-path keys are derived from the canvas id
   (= F2 `slug`): `canvasKeys(id)` → `{pixels, gauge, meta/version, frozen, stream,
   bans, op}` (`packages/redis-scripts`). One namespace shared by `place.lua`, the
   gateway, and the worker so placements, ban set, freeze flag, stream and snapshot
   all agree.

### Rejected alternatives

- **Integrated gateway (inside Convex / the web app).** Rejected: couples socket
  scaling to app/DB, puts durable-store latency on the live path, and Convex is not
  a socket server. (This is the explicit "separate vs integrated" arbitration.)
- **DB-table notifications + polling** (old repo). Rejected: couples fan-out to
  durable writes and forces client refetch; does not scale to stream audiences.
- **Per-pixel durable history as the live feed.** Rejected: snapshot + compact
  deltas ([ADR-0006](0006-snapshot-format.md)) is far smaller than replaying
  history.

## Consequences

- **Positive.** Live fan-out scales on replicas independent of DB; pub/sub is never
  blocked by durability; reconnections are cheap (replay, not reload); the hot path
  is a single atomic Lua round-trip (no TOCTOU — also mitigates R1's write side and
  the gauge race). One per-canvas key namespace keeps every component consistent.
- **Negative / bounded.** The gateway is a new operational unit (its own container,
  health check, deploy) — accepted; it is the component that *must* scale alone.
  Single-replica MVP handles low-thousands; >10k is the replica path above and needs
  a quantitative load test on the NAS (tracked under R1 / chantier **A6**). The
  replay buffer is bounded; older reconnects fall back to a full snapshot.
- **Durability/recovery** (R2) is owned by the worker via a Redis Streams consumer
  group with idempotent, version-ordered Convex writes; XACK only after a successful
  write → at-least-once, no lost placements. The moderation-stream durability gap is
  tracked as a worker follow-up (this ADR § referenced by the worker README).

## Traceability

| D3 requirement (proposition §3.2 A3)         | Satisfied by                                      |
| -------------------------------------------- | ------------------------------------------------- |
| separate WS gateway service (vs integrated)  | `apps/gateway` behind `/ws` (Caddyfile)           |
| fan-out decoupled from durable DB            | Redis pub/sub sink ⟂ Convex (two sinks, FEN-54)   |
| "message carries the data → 0 refetch"       | delta frame contains the pixel; no DB round-trip  |
| catch-up from tick T on reconnect            | per-frame `seq` + `resync` (protocol)             |
| replaces `canvas__sync_notifications`+polling| pub/sub + stream (anti-example FEN-549/FEN-572)   |
| atomic hot path (no TOCTOU)                  | `place.lua` single round-trip                     |
</content>
