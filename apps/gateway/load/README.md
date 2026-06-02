# Gateway fan-out load proof (FEN-50 / F7-CA1)

Proves the realtime gateway's CA1 invariant: a single pixel write fans out to
**1 000 concurrent sockets** with **zero per-socket DB read** and **one** Redis
delta subscription, in-process.

## Run

```bash
pnpm --filter @canvas/gateway exec tsx load/fanout-load.ts
```

Tunables (env): `LOAD_PLATEAUS` (default `1,10,50,100,250,500,1000`),
`LOAD_ROUNDS` (default `3`), `FLUSH_INTERVAL_MS` (default `10`).

Exit code `0` = CA1 PASS, `1` = FAIL. The full JSON report and a `RESULT:` line
are printed to stdout; the latest captured artifact is in `results/`.

## What it does

- Drives real `ws` clients against a real `Gateway`, ramping the connection count
  1 → 1 000. At each plateau it places one pixel and asserts every connected socket
  receives exactly one DELTA frame carrying that write's `seq`.
- Redis is an instrumented in-process double (`instrumentedRedis.ts`) that counts
  every command, so the harness can assert the fan-out path issues **zero** Redis
  commands per socket and the delta subscription count stays `1` as N scales.
- Captures p50/p95/p99 fan-out latency, isolated server-side broadcast spread,
  Redis command deltas, and RSS.

## Files

- `fanout-load.ts` — the harness + CA1 verdict.
- `instrumentedRedis.ts` — command-counting in-process Redis double.
- `results/` — captured artifact (`fanout-ca1.md`, `fanout-ca1.json`).

A live-Redis / distributed re-run belongs to the NAS smoke (FEN-25).
