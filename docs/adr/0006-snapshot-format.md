# ADR-0006 — Snapshot format (D2): dense palette-indexed binary, reject JSON-sparse

- Status: **Accepted** (ratifies the format already shipped in `@canvas/protocol`)
- Date: 2026-06-17
- Owner / decider: Founding Engineer (owns decision **D2** per the CEO directive)
- Affects: `packages/protocol` (`encodeSnapshot`/`decodeSnapshot`, `bin-palette-v1`),
  `apps/convex/convex/schema.ts` (durable snapshot blob), the persistence worker
  ([persistence-worker.md](../contracts/persistence-worker.md)), the WS gateway
  initial-load path, the web canvas + OBS renderer.
- Issue: chantier **A2** of [FEN-607](/FEN/issues/FEN-607) (proposition-refonte §3.2,
  criterion C6). Anti-example sourced from the old repo ([FEN-549](/FEN/issues/FEN-549)).

> **Numbering note.** Code comments and `docs/risks.md` historically referenced the
> snapshot decision as "ADR-0002 / D2" and linked `adr/0002-snapshot-format.md`.
> That slot was taken by the auth→gateway JWT bridge ([ADR-0002](0002-auth-gateway-jwt-bridge.md)),
> so the snapshot ADR is filed here as **0006**. References to "ADR-0002" *in the
> snapshot / `bin-palette` sense* mean this ADR. Aligning the inline comments is a
> hygiene task under A8 ([FEN-607](/FEN/issues/FEN-607)).

## Context

The initial canvas load and the OBS overlay both need the **entire** board in one
payload, fast, for up to a 512×512 fresco (262 144 cells) under Twitch-scale
concurrency (R1). The old repo (`liveplace_next`) stored and served the canvas as a
**JSON sparse map** `pos → { color, … }` (`get_canvas_binary` was, despite its name,
sparse JSON — see [FEN-549](/FEN/issues/FEN-549)). That choice is the anti-example
this decision rejects:

- **Unbounded, content-dependent size.** A full board is hundreds of thousands of
  object entries with repeated `"x"`/`"y"`/`"color"` keys — multi-MB of JSON for a
  state that is *intrinsically* one byte per cell.
- **Transcoding on every load.** Redis already holds the canvas as a byte string;
  serving JSON means decode → re-encode on the hot read path.
- **No zero-copy snapshot.** It defeats "the message carries the data" — the server
  must walk a map instead of `GET`-ing a buffer.

D2 must pick a snapshot format that is compact, O(canvas) to produce, and renderable
without per-cell object churn.

## Decision

**The snapshot is a dense, palette-indexed binary buffer: 1 byte per pixel,
row-major — `bin-palette-v1`.** A pixel's byte is an index into the fixed canvas
palette (≤ 256 colours; the MVP palette is 32). This is exactly the format already
frozen in `@canvas/protocol`:

```
SNAPSHOT (op 0x01): [u8 op][u32 seq][u16 width][u16 height][u8 pixels[width*height]]
DELTA    (op 0x02): [u8 op][u32 seq][u16 count][ {u16 x,u16 y,u8 color} * count ]
```

- **Storage = wire = Redis layout.** The canvas lives in Redis as a 1-byte/pixel
  string (`SETRANGE` at `y*width+x`, `place.lua`). The snapshot is a **verbatim
  `GET`** of that string plus a 9-byte header — zero transcoding on the hot read.
- **Durable copy** is the same buffer: the worker uploads the `bin-palette-v1` blob
  to a Convex file (`schema.ts` snapshot table), versioned by `seq`. Restore =
  download the blob → `SETRANGE` into Redis → replay newer stream entries (R2).
- **Rendering** is a single palette→RGBA expansion shared by web + OBS
  (`paletteToRGBA`), feeding `ImageData` — no per-pixel JSON parse.
- **On the wire** the snapshot is gzip'd by the reverse proxy / WS layer; a dense
  palette buffer compresses extremely well (large flat regions), so the ~262 KB raw
  512² board ships as tens of KB.

**Rejected — JSON-sparse `pos → {…}`** (the old repo) for the reasons above.

**PNG** was the directive's stated alternative ("buffer dense … **ou** PNG"). PNG is
*also* a dense raster and would compress comparably, but it is **rejected for the
hot path** because it forces an encode step (the canvas is not natively a PNG in
Redis) and a decode step in the client before we can index pixels for deltas — i.e.
it re-introduces transcoding that the raw palette buffer avoids. PNG remains the
right format for **off-hot-path renders** (gallery thumbnails, social cards), which
already render server-side in the worker — that is not a snapshot-transport
decision and stays out of D2.

### Palette > 256 colours

If a future canvas ever exceeds 256 palette entries, 1 byte/pixel no longer indexes
it. The directive's fallback ("sinon RGBA") applies: bump the format to
`bin-rgba-v2` (4 bytes/pixel) under a new opcode + `PROTOCOL_VERSION` bump. The MVP
palette is 32, so v1 stands; this is recorded so the ceiling is explicit, not a
silent assumption.

## Consequences

- **Positive.** Smallest possible snapshot for the data; zero-copy from Redis;
  one rendering path for web + OBS; delta records are a fixed 5 bytes; durable blob
  and live buffer are byte-identical (R2 restore is trivial). Directly serves R1
  (compact payloads) and "0 refetch" — the snapshot *is* the state.
- **Negative / bounded.** Capped at 256 palette colours per the 1-byte index (escape
  hatch above). Width/height are u16 (≤ 65 535) — far above the 512 ceiling
  ([ADR-0004](0004-canvas-dimension-contract-512.md)). Clients **must** read
  width/height from the snapshot header, never hard-code geometry (already in the
  protocol contract).
- **Frozen.** `bin-palette-v1` is part of the `@canvas/protocol` v1 contract; a
  breaking change bumps `PROTOCOL_VERSION` and updates this ADR.

## Traceability

| D2 requirement (proposition §3.2 A2)        | Satisfied by                                       |
| ------------------------------------------- | -------------------------------------------------- |
| dense buffer, 1 byte/px if ≤ 256 colours    | `bin-palette-v1`, `encodeSnapshot` (protocol)      |
| RGBA fallback if > 256 colours              | `bin-rgba-v2` escape hatch (above)                 |
| reject JSON-sparse `pos→{…}`                | rejected here; anti-example FEN-549 / FEN-572      |
| feeds initial load + OBS                    | gateway initial-load + `paletteToRGBA` shared path |
| durable snapshot                            | Convex blob, `seq`-versioned (worker, R2)          |
</content>
