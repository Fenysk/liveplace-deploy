# LivePlace — Risk register (R1/R2)

Covers the technical mitigation of the two brief-level risks. The product/UX
arbitration of R1/R2 is owned in parallel by the Product Owner
([FEN-9](/FEN/issues/FEN-9)); this document is the Founding Engineer's technical
mitigation (originally scoped as [FEN-7](/FEN/issues/FEN-7), folded into the
foundation work [FEN-10](/FEN/issues/FEN-10)).

---

## R1 — Stream/WS gateway latency under load (>10k concurrent viewers)

- **Title:** Live canvas stays fluid at high viewer concurrency.
- **Description:** Twitch streams can drive 10k+ simultaneous viewers onto the
  canvas/OBS view. If the WS fan-out or per-placement broadcast can't keep up,
  pixels lag the stream, the canvas feels sluggish, and the OBS overlay drifts
  from reality.
- **Impact:** **High** — the core promise is "see your pixel live on stream."
- **Probability:** **Medium** — only bites at large concurrency, but that is
  exactly the success scenario for a Twitch-driven product.
- **Mitigation (taken / designed in):**
  1. **Dedicated, stateless, horizontally-scalable gateway** ([ADR 0003](adr/0003-ws-gateway-topology.md)).
     N replicas all subscribe to one Redis pub/sub channel; add replicas to add
     fan-out capacity. No per-connection server state → no sticky sessions.
  2. **Atomic O(1) hot path.** Placement is a single `place_pixel.lua` round-trip
     (bounds + gauge + write + XADD + PUBLISH). No multi-key transactions, no
     app-side read-modify-write.
  3. **Compact payloads.** Live deltas are ~40-byte JSON; the initial load is a
     gzip'd `bin-palette-v1` snapshot (~hundreds of KB for 1e6 px), not per-pixel
     history ([ADR 0006](adr/0006-snapshot-format.md)).
  4. **Server-side coalescing knob.** Protocol includes a batched `pixels` frame
     so a gateway under burst can coalesce N placements into one frame per tick
     instead of N frames — bounded client message rate.
  5. **Cooldown caps write rate.** Per-user gauge (D1) bounds placements/sec, so
     write throughput is naturally throttled independent of read fan-out.
- **Residual risk / next step:** Real numbers require a load test against the NAS
  (k6/autocannon driving M sockets). Tracked for the realtime issue
  [FEN-13](/FEN/issues/FEN-13). Single-replica MVP is expected to handle low-
  thousands; >10k is the replica-scaling path above.
- **Status:** **Atténué (mitigated)** — architecture removes the structural
  bottleneck; quantitative load test pending on real hardware.

---

## R2 — Canvas consistency under concurrent writes (Redis ↔ Convex divergence)

- **Title:** Durable state never silently diverges from the live canvas.
- **Description:** `place_pixel.lua` makes individual writes atomic, but the
  **durable** copy in Convex is populated by a periodic batch flush. If a flush
  fails, the gateway crashes mid-flush, or Redis is lost, the Convex snapshot can
  diverge from the true canvas, and a restart could restore a stale board.
- **Impact:** **High** — silent data loss / canvas rollback is user-visible and
  erodes trust.
- **Probability:** **Medium** — flush failures and restarts are routine over a
  long-running event.
- **Mitigation (taken / designed in):**
  1. **Single source of truth on the hot path.** Redis is authoritative for live
     state; Convex is the durable mirror. There is exactly one writer path
     (`place_pixel.lua`), so no concurrent-writer divergence at the source.
  2. **Durable, replayable queue.** Every placement is appended to a Redis
     **Stream** (`canvas:*:stream`) inside the same atomic script as the pixel
     write. The flush worker consumes via a **consumer group** and only `XACK`s
     after a successful Convex write → at-least-once delivery, no lost placements
     on flush failure (it retries the un-acked entries).
  3. **Monotonic version.** Each write bumps `meta.version` (also embedded in the
     snapshot). Convex stores the last-applied version; flushes are idempotent
     and ordered, so replays can't double-apply or regress.
  4. **Redis durability.** Compose configures Redis with **AOF (appendonly)** on a
     persistent NAS volume, so a Redis restart recovers the live canvas; the
     Stream backlog survives to be re-flushed.
  5. **Recovery path.** On cold start, the gateway loads the canvas from Redis;
     if Redis is empty, it restores from the latest Convex `bin-palette-v1`
     snapshot then replays any newer stream entries. Defined for the persistence
     worker [FEN-17](/FEN/issues/FEN-17).
- **Residual risk / next step:** Total NAS-volume loss (Redis AOF + Convex both
  gone) is unrecoverable — mitigated operationally by NAS RAID/backups (DevOps).
- **Status:** **Atténué (mitigated)** — stream+consumer-group+versioning gives
  at-least-once idempotent durability; periodic-snapshot recovery implemented in
  the persistence worker issue.

---

## Escalation

Neither risk is escalated as blocking: both are mitigated by the foundation
architecture above. The only items requiring the human operator are physical:
NAS RAID/backup policy (DevOps) and a load test on real hardware. Flagged to the
CEO in the [FEN-10](/FEN/issues/FEN-10) thread for awareness, not as blockers.
