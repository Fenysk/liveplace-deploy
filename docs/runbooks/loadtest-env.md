# Disposable load-test environment (FEN-511 / T3)

> **Source plan:** [FEN-495 §5](/FEN/issues/FEN-495#document-plan).
> **Critical decision: never prod, never real data.**

A throwaway copy of the LivePlace stack for hammering the gateway / Redis / worker
hot path in isolation. It runs the **same Dockerfiles as production** but in a
self-contained, disposable topology so a load run can never touch prod data,
prod Redis, prod Convex, or the prod domain.

What comes up:

```
redis → convex-backend (self-hosted, FREE in Convex metering)
      → convex-admin-key → convex-deploy (push functions into the TEST Convex)
      → gateway (WS hot path, published to the host for the driver)
      → worker  (batch-flush Redis stream → TEST Convex, end-to-end)
```

No `web` SPA and no `proxy`/TLS: a load run drives the **raw gateway** directly,
and there is no point provisioning certs on a throwaway box (it would also risk
burning Let's Encrypt rate limits). Self-hosted Convex is **free in metering**, so
the end-to-end flush is measured at zero Convex cost.

---

## ⚠️ Where NOT to point this

- **Never on the prod VPS.** Run it on a **separate machine** — a beefy dev box or
  a small temporary staging VM — so it never contends for CPU / RAM / disk with
  production. Load by definition saturates resources; co-locating would degrade
  the live site.
- **Never the prod domain / prod Convex / prod Redis.** `.env.loadtest` must keep
  local URLs. `loadtest.sh` refuses to start if it sees a `liveplace.tv` /
  `canvas.*` HTTPS URL, or if `GATEWAY_CANVAS_ID` is not a `loadtest-*` slug.
- **Canvas slugs are `loadtest-*`** (default `loadtest-default`) so a test canvas
  can never be confused with a real one.

## Isolation guarantees (defense in depth)

1. **Project name pinned** to `liveplace-loadtest` (top-level `name:` in the
   compose). Its volumes/network are namespaced `liveplace-loadtest_*` and cannot
   collide with a prod stack even without a `-p` flag.
2. **Separate env file:** every service reads only `.env.loadtest`, never `.env`.
   No inheritance of prod secrets/URLs.
3. **Distinct Convex instance** (`INSTANCE_NAME=liveplace-loadtest`).
4. **All volumes disposable:** `redis-data`, `convex-data-2`, `convex-admin` are
   removed by `down -v` (the `clean` command). No residue.

---

## Quick start

Prereqs: Docker + Compose v2, Node ≥ 22 (for the smoke), on a **non-prod** machine.

```bash
# 1. From the repo root. First run auto-creates .env.loadtest from the example.
./scripts/loadtest.sh up        # build + start the isolated chain (detached)

# 2. Prove the chain is live end to end (WS place → ack → live broadcast).
./scripts/loadtest.sh smoke

# 3. Run your load driver (T1/T2) against the published gateway:
#       ws://localhost:8080      (or $LOADTEST_GATEWAY_PORT)
#    Use canvas slug(s) prefixed loadtest-*.

# 4. Inspect while it runs.
./scripts/loadtest.sh logs
./scripts/loadtest.sh ps

# 5. Tear down.
./scripts/loadtest.sh down      # stop, KEEP the disposable volumes
./scripts/loadtest.sh clean     # stop AND DELETE the throwaway data (down -v)
```

`./scripts/loadtest.sh config` renders the merged compose without starting
anything — use it to validate edits.

---

## Single-canvas ceiling vs 20-canvas fanout (FEN-516)

`docker-compose.loadtest.yml` ships **one** gateway + **one** worker, both pinned
to a **single** canvas via `GATEWAY_CANVAS_ID`. The gateway resolves its canvas
from that env, **not** from the WS path (`apps/gateway/src/config.ts`), and the
worker drains exactly one `canvas:{slug}:stream`
(`apps/worker/src/index.ts` — *“Single-canvas MVP: one slug, one drain loop”*).

So the single-canvas stack is a **mono-canvas ceiling**: you can push up to
10 000 sockets at it, but Redis sees **one** stream and **one** worker drains it.
That is a *harder broadcast* test, but it is **not** the graven **20 toiles × 500**
shape — there is no multi-canvas stream distribution and no worker-drain
parallelism. `docker compose --scale gateway=N` does **not** fix this: replicas
share identical config, so all land on the **same** canvas and cannot each publish
a distinct host port.

> ⚠️ If you run the single-canvas stack for a “20×500” campaign, **report it as a
> 10 000-conns mono-canvas ceiling — never as the 20-canvas number.**

### The fanout stack

For a faithful 20-canvas run, generate **N distinct gateways + N distinct
workers**, each pinned to `loadtest-<i>` on its own host port, over **one shared**
Redis + Convex. This is the `liveplace-loadtest-fanout` project, produced by the
source-of-truth generator `scripts/loadtest-fanout.mjs` (pure compose
orchestration — no app-code change; the stack is owned by Alexis).

```bash
# 1. Generate + start the 20-canvas stack (defaults: 20 canvases, base port 8100
#    → gateway-<i> on 8100..8119). HEAVY — run it on a beefy, non-prod box.
./scripts/loadtest.sh fanout-up            # or: fanout-up <N> <BASE_PORT>

# 2. Prove EVERY per-canvas gateway is live (WS place → ack → broadcast on each).
./scripts/loadtest.sh fanout-smoke

# 3. Feed the per-canvas targets into the campaign runner (FEN-512):
./scripts/loadtest.sh fanout-targets       # prints TARGET_URLS=ws://localhost:8100,...
#    or `source .env.loadtest-fanout-targets` and use $TARGET_URLS. Drive ~500
#    sockets per URL for 20×500 = 10 000 conns across 20 real canvases.

# 4. Inspect / tear down (separate project → never touches the single-canvas stack).
./scripts/loadtest.sh fanout-ps
./scripts/loadtest.sh fanout-logs
./scripts/loadtest.sh fanout-down          # stop, KEEP volumes
./scripts/loadtest.sh fanout-clean         # down -v: stop AND DELETE throwaway data
```

`fanout-up`/`fanout-gen` always regenerate the compose from the generator first,
so the committed `docker-compose.loadtest.fanout.yml` can never drift silently.
Change canvas count or base port with `fanout-gen <N> <BASE_PORT>`. The same
`.env.loadtest` (and its prod-pointing guardrails) applies; each canvas is still a
`loadtest-<i>` slug, so a fanout run can never be confused with a real canvas. All
gateways share one built image and all workers share another (`build:` runs once),
so 20 services do **not** rebuild the context 20×.

> **Resource note:** the default stack is 20 gateways + 20 workers + Redis + Convex
> = 42 containers, holding ~10 000 sockets. Size the box accordingly (CPU/RAM/file
> descriptors); this is why it must run on a dedicated non-prod machine.

---

## Gauge sizing: realistic vs raw-ceiling

The gauge caps **accepted placements per user**. Two modes, switched in
`.env.loadtest` (see the commented block there):

| Mode | When | Effect |
|------|------|--------|
| **(A) Realistic** *(default)* | Believable-crowd run | D1 prod values (`GAUGE_MAX_BASE=20`, +1 charge / 30 s). Throughput is bounded by gauge × sockets, exactly like prod. |
| **(B) Relaxed / raw ceiling** *(opt-in)* | Find the infra plateau | Huge bucket + near-instant refill so the gauge never throttles; a few sockets can saturate Redis/worker. Pair with a high `SOCKET_INBOUND_REFILL_PER_SEC`. |

> ⚠️ **A relaxed-gauge run is a RAW CEILING measurement, not a realistic user-load
> number.** Always label its results as such in any report.

To switch to raw-ceiling: in `.env.loadtest`, comment out block **(A)**, uncomment
block **(B)**, and raise `SOCKET_INBOUND_REFILL_PER_SEC` (e.g. `1000`). Then
`./scripts/loadtest.sh down && ./scripts/loadtest.sh up` to apply.

## Measuring the end-to-end flush

The **worker** flushes the Redis placement stream into the TEST Convex
(`FLUSH_INTERVAL_MS` / `FLUSH_MAX_BATCH`). To study flush behaviour under pressure,
lower `FLUSH_INTERVAL_MS` and/or raise the offered load, then watch
`./scripts/loadtest.sh logs` (worker batch sizes / lag) and the Convex backend.
Because Convex here is self-hosted and disposable, this costs nothing and never
touches prod tables.

## Files

| File | Role |
|------|------|
| `docker-compose.loadtest.yml` | Single-canvas disposable stack (project `liveplace-loadtest`). Mono-canvas ceiling. |
| `docker-compose.loadtest.fanout.yml` | **Generated** N-canvas stack (project `liveplace-loadtest-fanout`). N gateways + N workers. Regenerate, don't hand-edit. |
| `scripts/loadtest-fanout.mjs` | Source-of-truth generator for the fanout stack + `TARGET_URLS` (FEN-516). |
| `.env.loadtest.example` | Committed template (dummy values). Copy → `.env.loadtest` (gitignored). |
| `.env.loadtest-fanout-targets` | **Generated** (gitignored) — `TARGET_URLS` list of per-canvas `ws://` URLs for the campaign runner (FEN-512). |
| `scripts/loadtest.sh` | Single-canvas (`up`/`smoke`/…) **and** fanout (`fanout-up`/`fanout-smoke`/`fanout-targets`/…) commands, with prod-pointing guardrails. |
| `scripts/smoke.mjs` | The canonical WS live-pixel smoke, reused by `loadtest.sh smoke`. |
