# Runbook — PROD stress test: run environment, monitoring & guardrails (FEN-1279)

> Owner: **DevOps**. Scope: prepare a **SAFE** stress test against **prod**
> LivePlace at ~1–3k simultaneous WebSocket clients, in off-peak hours.
> This runbook does **not** launch the run. It is the go/no-go + the dashboard +
> the guardrails the operator uses on the day. The load **driver/harness** is
> owned by the Founding Engineer; this is the prod-side environment around it.

---

## 0. TL;DR — Go/No-Go

| Question | Verdict |
| --- | --- |
| Can the **agent sandbox** open 2–3k WS connections to prod? | **Capacity: YES.** Operationally: **NO — use a dedicated runner.** (see §1) |
| Recommended window | **Tue–Thu, 05:00–07:00 Europe/Paris** (validate vs real traffic, §2) |
| Monitoring ready? | **Yes** — `scripts/stress-monitor.mjs` + Convex dashboard + Coolify (§3) |
| Guardrails defined? | **Yes** — kill-switch + abort criteria + cleanup (§4) |

**Overall: GO for feasibility, conditioned on (a) a dedicated runner VM, (b) prod
green at T-0, (c) the monitor running with a locked baseline before the driver
starts.** Detail below.

---

## 1. Egress feasibility (priority #1) — MEASURED

**Question:** where does the load generator run, and can it open 2–3k WS
connections to prod?

### Measurements (from the agent sandbox, 2026-06-28)

| Check | Result | Meaning |
| --- | --- | --- |
| FD limit (`ulimit -n`) | **524288** | ≫ 3k sockets. Not a constraint. |
| Ephemeral ports (`ip_local_port_range`) | **32768–60999 (~28k)** | To a single prod IP:443 → ~28k tuples. 3k fits ~9× over. |
| Local concurrent sockets held | **3000/3000, 0 failed** | Event-loop + FD capacity for 3k simultaneous sockets confirmed. |
| Concurrent TLS handshakes to prod | **100/100 OK, 0 err, p95 885ms** | Egress path + TLS to prod works under concurrency. |
| CPU / RAM | **4 vCPU / 8 GB (≈4 GB free)** | 3k *idle* WS ≈ 100–200 MB. Driving pixel traffic at scale wants headroom. |
| Egress public IP | **88.190.129.228 (single IP)** | All connections share one source IP. See caveat. |

**Conclusion on raw capacity:** the sandbox *can* open and hold 2–3k WS
connections to prod. Network, FD, ephemeral-port, and TLS-handshake limits are
all comfortably clear.

### Why the sandbox is NOT the right place to RUN it — recommend a dedicated runner

1. **Short-lived heartbeat windows.** The agent runs in bounded heartbeats, not a
   stable long-lived process. A 20–30 min sustained run cannot be guaranteed to
   survive a heartbeat boundary. A stress run needs a host that stays up for the
   whole window independent of the agent loop.
2. **Single source IP (88.190.129.228).** 3k connections from one IP is an
   unrealistic load shape (looks like one abusive client, not 3k users) and
   collides with any current/future per-IP protection. Today there is **no Caddy
   per-IP connection cap and no gateway per-IP connection limit** (only a
   per-socket inbound *message* token bucket, G-I2 — see `apps/gateway/src/rateLimiter.ts`),
   so the test would not be throttled — but the realism gap remains, and we do
   not want to bake a single-IP assumption into the harness.
3. **Shared resources.** The sandbox box is shared; sustained high-rate message
   generation competes with other agents.

**Recommendation (decision for Founding Eng before finalizing the harness):**

- Run the driver on a **dedicated disposable cloud VM** (e.g. a 4–8 vCPU /
  8–16 GB instance: Hetzner/Scaleway/OVH, same EU region as the NAS to keep RTT
  realistic). Provision via cloud-init, destroy after the run — no snowflake.
- For 3k+ and a realistic shape, prefer **2–4 small VMs** (distinct source IPs,
  ~750–1500 conns each) over one big box. This also de-risks single-host limits.
- Tune the runner host the same way: `ulimit -n 1048576`,
  `net.ipv4.ip_local_port_range="15000 65000"`, `net.ipv4.tcp_tw_reuse=1`.
- The **agent sandbox is fine for the REHEARSAL / smoke** (100–500 conns, short)
  to validate the harness end-to-end before the real run — its egress is proven
  above. Use `scripts/smoke.mjs` against `wss://liveplace.tv/ws/`.

> If the board prefers zero extra infra, a *reduced* run (≤ ~800 conns, single
> short burst within one heartbeat) is mechanically possible from the sandbox,
> but it is not the 1–3k target and is not recommended as the primary plan.

---

## 2. Off-peak window

We have **no first-party traffic-analytics time-series** yet (no APM/RUM; the
only counters are outreach attribution in `GET /r/report`). The recommendation is
reasoned from the audience and **must be validated** before locking the slot.

- LivePlace is Twitch-integrated; the audience is FR/EU. EU Twitch traffic peaks
  **18:00–01:00 Europe/Paris** and weekend afternoons. The trough is weekday
  **early morning**.
- **Recommended: Tuesday–Thursday, 05:00–07:00 Europe/Paris (CEST in June).**
  Avoid Mon (deploy backlog) and Fri/weekend (streamer events).

**Validate the window at T-1 day** (do not skip — replace the assumption with a
measurement):

- Run `scripts/stress-monitor.mjs` for ~10 min at the candidate hour and at a
  known-peak hour; compare baseline latency/error rate. The off-peak slot should
  show clearly lower idle latency.
- Cross-check the Convex self-hosted dashboard **Functions** view for call-volume
  by hour, and the Coolify app graph for request volume, over the prior week.
- Confirm with the board there is **no scheduled stream / launch event** in the
  window (real-user degradation during a stream is the worst-case blast radius).

---

## 3. Live monitoring dashboard

Three layers. Run all three during the test; the operator watches #1, escalates
on #2/#3.

### 3.1 Prod-side monitor (this repo) — `scripts/stress-monitor.mjs`

Dependency-free Node poller. Samples every 5s: `/healthz` (edge+web), `/convex/version`
(Convex backend), a raw TLS connect (egress), and — if a Coolify token is set —
the app `running:healthy` status. Computes a rolling **error rate** and flags
**latency > 3× baseline** and any **5xx**; 3 consecutive flagged samples print a
loud **ABORT RECOMMENDED** banner.

```bash
# 1) Lock a baseline with the driver OFF (~1 min):
node scripts/stress-monitor.mjs --interval 5 --baseline-samples 8

# 2) With Coolify CPU/mem + container status (recommended):
COOLIFY_API_TOKEN=$COOLIFY_API_TOKEN_3 COOLIFY_APP_UUID=<app-uuid> \
  node scripts/stress-monitor.mjs --interval 5 --slo-mult 3 --max-error-rate 0.05
```

Flags: `--host` (default `liveplace.tv`), `--interval` (s), `--slo-mult` (default
3), `--max-error-rate` (default 0.05), `--window` (rolling samples), `--baseline-samples`.

> **Procedure:** lock the baseline BEFORE the driver starts, then start the
> driver. SLO ceilings are computed from that idle baseline (`p95 > 3×` → abort
> criterion). Keep this terminal visible — it is the human-facing dashboard.

### 3.2 Convex (self-hosted) — function latency & errors

- **Dashboard UI** (self-hosted Convex) — *Functions* tab: per-function call
  rate, **p50/p95 execution time**, and **error counts**; *Logs* tab for live
  errors/exceptions. This is the authoritative view for "function latency" and
  "errors" called out in the ticket. Open it for the prod deployment for the run.
- Backend liveness probe: `GET https://liveplace.tv/convex/version` → 200 (the
  monitor already polls this and times it).
- Watch the **worker drain**: the Redis→Convex batch-flush is the persistence
  ceiling. A growing `canvas:{slug}:stream` backlog = the worker can't keep up
  (back-pressure). Inspect via the gateway/worker logs and Redis `XLEN`.

### 3.3 Infra — Coolify (CPU / mem / 5xx / restarts)

- **Coolify** app view: container **CPU/mem**, `restart_count`, `last_restart_at`,
  `status`. The monitor pulls `status` via the API when `COOLIFY_API_TOKEN` +
  `COOLIFY_APP_UUID` are set; for live CPU/mem graphs use the Coolify UI.
- **5xx**: the monitor counts non-2xx on `/healthz` + `/convex/version`. For a
  fuller picture tail Caddy access logs in the Coolify proxy view and filter
  status ≥ 500.
- **Known false-positive:** a Coolify deploy/rollover serves edge **503 for
  ~60–112s** (single-replica recreation, no blue-green — FEN-1098/1101). The
  Caddy SPA fallback bridges only ~10s (`lb_try_duration`). **Do not deploy
  during the run**, and treat a sudden 503 burst as "is a deploy running?" before
  treating it as load-induced failure.

---

## 4. Guardrails

### 4.1 Kill-switch (ordered, fastest first)

1. **Stop the load driver.** It is *our* process — `Ctrl-C` / kill the runner
   process(es) on the runner VM(s). This is the cleanest stop: connections drop,
   prod recovers on its own. **This is the primary kill-switch.** Have the exact
   stop command ready in the same terminal before starting.
2. **Emergency freeze (per-canvas).** If a *specific canvas* is melting but you
   want to keep the run, freeze placements without dropping sockets:
   ```bash
   curl -fsS -X POST https://liveplace.tv/ws/internal/freeze \
     -H "Authorization: Bearer $GATEWAY_INTERNAL_SECRET" \
     -H 'content-type: application/json' -d '{"frozen":true}'
   # unfreeze: -d '{"frozen":false}'
   ```
   (Handler: `apps/gateway/src/gateway.ts` `handleFreeze`, F8.4/CA4. Requires
   `GATEWAY_INTERNAL_SECRET` — board-provided, never in repo.)
3. **Nuclear — stop the gateway** via Coolify (scale gateway to 0 / stop the
   service). Drops all sockets. Use only if 1–2 fail; this is a visible outage to
   any real users still on.

> Pre-stage the kill-switch: open the runner-stop terminal AND a terminal with the
> freeze curl ready (secret loaded) BEFORE the run starts.

### 4.2 Abort criteria (any one → hit the kill-switch)

- **Error rate > 5%** over the rolling window (monitor flags `errXX%`).
- **p95 latency > 3× SLO baseline** on `/healthz` or Convex functions (monitor
  flags `>SLO`; cross-check the Convex Functions p95).
- **Real-user degradation**: any 5xx not explained by a deploy, OR Coolify shows
  `restart_count` increasing / container OOM / status ≠ running:healthy.
- **Worker back-pressure**: Redis stream backlog grows monotonically and does not
  drain (persistence falling behind).
- Monitor prints **ABORT RECOMMENDED** (3 consecutive flagged samples).

### 4.3 Write isolation + test-data cleanup

> ⚠️ **A "throwaway slug in the WS URL" does NOT isolate writes.** The prod
> gateway is **single-canvas**: it serves whatever `GATEWAY_CANVAS_ID` it was
> started with (prod = `default`) and **ignores the WS path slug**
> (`apps/gateway/src/gateway.ts`, `config.ts:131`). So `wss://liveplace.tv/ws/stress-…`
> would still write to the live `default` art. Isolation must be at the
> **gateway / canvas-id** level. (Founding-Eng correction, FEN-1280.)

**Target → a dedicated stress gateway, NOT the primary host.** Stand up a second
gateway + worker pair against the **same prod Redis + Convex** (so the run still
stresses the real shared hot path — `place.lua`/gauge on Redis = R1, worker drain
to Convex = R2), but started with `GATEWAY_CANVAS_ID=stress-YYYYMMDD`. Writes then
land in `canvas:stress-YYYYMMDD:*` (Redis) and as Convex placements by
`loadtest:user:*` → **isolated, filterable, cleanable; the live `default` canvas
is untouched.** Overlay shipped at **`docker-compose.stress.yml`** (services
`gateway-stress` on host port `8090` + `worker-stress`); bring-up / tear-down /
reachability are documented in its header. Pattern mirrors
`docker-compose.loadtest.fanout.yml`.

**Auth → per-user dev-JWT, NOT anonymous.** Two traps:
- Tokenless sockets are **read-only** and refuse `place` (`auth.ts` CA5) → an anon
  fleet would place nothing.
- `GATEWAY_AUTH_DISABLED` collapses every socket onto one shared `userId="anon"`
  and one shared `gauge:anon` (FEN-532) → the whole fleet throttles to ~1px /
  cooldown, and it is **never set on prod**.

  So the harness mints per-user HS256 dev-JWTs (`sub=loadtest:user:N`) signed with
  the **stress gateway's** `GATEWAY_DEV_JWT_SECRET` → each actor gets its own gauge
  bucket. No Twitch / Better-Auth session is created → **nothing auth-side to
  clean** (the no-cleanup goal still holds).

**Cleanup after the run:**
1. Tear down the overlay (`gateway-stress` + `worker-stress`) and **rotate
   `GATEWAY_DEV_JWT_SECRET`**.
2. **Convex side** (owned by Dev Full-stack — file a follow-up if a bulk delete is
   needed): delete `canvas=stress-YYYYMMDD` + its pixels. Capture before/after
   counts so cleanup is verifiable.
3. **Redis side**: the disposable `canvas:stress-YYYYMMDD:*` keys can be dropped
   (`DEL`/key scan) once Convex is reconciled.
4. **Verify clean**: gallery/home shows no stress canvas; Convex tables back to
   pre-run counts for the stress slug.

---

## 5. Pre-flight checklist (day of run)

- [ ] Window confirmed off-peak (§2) and board confirms no stream/launch in slot.
- [ ] Dedicated runner VM(s) provisioned, tuned (`ulimit`, sysctl), driver deployed.
- [ ] Prod **green** at T-0: `/`, `/healthz`, `/convex/version`, `/ws` all 200
      (re-probe — prod can be transiently 503 mid-rollover; wait it out).
- [ ] **No deploy** scheduled/in-flight during the window.
- [ ] `scripts/stress-monitor.mjs` running, **baseline locked** (driver still OFF).
- [ ] Convex self-hosted dashboard open (Functions + Logs), Coolify app view open.
- [ ] Kill-switch staged: runner-stop terminal + freeze curl (secret loaded) ready.
- [ ] **`gateway-stress` + `worker-stress` overlay up** (`docker-compose.stress.yml`),
      `STRESS_CANVAS_ID=stress-YYYYMMDD`, `/healthz` 200 on `:8090`; driver
      reaches it (host port, or temp `stress.liveplace.tv` Caddy route).
- [ ] **`GATEWAY_DEV_JWT_SECRET` loaded** into the stress gateway (high-entropy,
      ephemeral) and matched by the driver's `DEV_SECRET`.
- [ ] Cleanup owner (Dev Full-stack) on standby for `canvas=stress-YYYYMMDD`.
- [ ] Ramp plan agreed with Founding Eng — `STAGES="200:60,800:60,1500:60,3000:60"`
      (actors:holdSeconds), abort re-checked before each climb. Do not jump to 3k.

**Run command** (driver, against the stress gateway — not prod's `/ws`):

```
STRESS_CONFIRM=1 WS_URL=ws://<nas-host>:8090/ws DEV_SECRET=$GATEWAY_DEV_JWT_SECRET \
  STAGES="200:60,800:60,1500:60,3000:60" \
  pnpm --filter @canvas/gateway exec tsx load/stress-run.ts
```
(with `scripts/stress-monitor.mjs` running alongside, baseline locked first).

---

## 6. Ownership / hand-offs

- **DevOps (me):** this runbook, the prod-side monitor, kill-switch infra,
  runner-VM recommendation, **the dedicated `gateway-stress`/`worker-stress`
  overlay (`docker-compose.stress.yml`) + its `GATEWAY_DEV_JWT_SECRET`**, go/no-go.
- **Founding Engineer:** the load driver/harness (`apps/gateway/load/stress-run.ts`)
  + ramp profile (`STAGES`) + dev-JWT minting + metrics/report.
- **Dev Full-stack:** Convex-side test-data cleanup (bulk delete of test canvas).
- **Board/Alexis:** provision the runner VM credentials (or approve the reduced
  sandbox run) + `GATEWAY_INTERNAL_SECRET` for the freeze kill-switch + final
  go/no-go on the window.
