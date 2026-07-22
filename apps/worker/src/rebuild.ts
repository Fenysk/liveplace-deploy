/**
 * FEN-1576 — hard rebuild of a canvas grid from its CORRECTED durable placements
 * (replay from v0), bypassing the snapshot entirely.
 *
 * WHY this exists (bloqueur découvert dans FEN-1567): `restoreIfNeeded` is
 * snapshot-based — it re-hydrates Redis from the latest durable snapshot bitmap +
 * the placement tail *after* that snapshot's version. After a reattribution
 * migration corrects the Convex source of truth (keep/move/delete placements),
 * that path CANNOT surface the fix: the stale snapshot still bakes the comingled
 * grid (fenysk → re-hydrates the bug), and a slug with no snapshot (trishael)
 * restores to empty. `recordSnapshot` reads the Redis grid, so it can't
 * regenerate a correct snapshot from the corrected placements either (circular).
 *
 * This capability breaks the circle: read ALL corrected placements from version
 * 0, `reconstructPixels` from an empty base, overwrite the live Redis grid
 * (comingled → correct), then record a FRESH, correct snapshot. The worker is the
 * only process with BOTH Redis write access AND the Convex `worker:run` seam, so
 * this necessarily runs here (a Convex-only fn cannot touch Redis).
 *
 * Triggered by the `REBUILD_SLUGS` worker boot env flag (see config/index) —
 * DEFAULT UNSET → inert. DevOps sets it for a single supervised run after
 * `executeReattribution {execute:true}`, then clears it.
 */
import type Redis from "ioredis";
import { reconstructPixels } from "./restore.js";
import { overwriteCanvas, readLiveGridNonEmpty, readRebuildMarker, writeRebuildMarker } from "./redis.js";
import { buildAndRecord } from "./snapshot.js";
import type { ConvexDurable, PlacementRecord } from "./convex.js";

export interface RebuildResult {
  slug: string;
  ok: boolean;
  /** Machine-readable outcome tag. */
  reason: string;
  width: number;
  height: number;
  /** Total corrected placements replayed from v0. */
  placements: number;
  /** Non-zero cells in the reconstructed bitmap (the visible pixel count). */
  nonEmpty: number;
  /** Effective Redis `meta` version after the (monotonic) overwrite. */
  version: number;
  /** Version stamped on the fresh snapshot (present only when it recorded). */
  snapshotVersion?: number;
  /** Byte length of the fresh snapshot blob. */
  snapshotBytes?: number;
  /**
   * FEN-1598: painted cells found in the LIVE grid at guard time (present only on
   * the anti-wipe abort path, `reason === "empty_replay_abort"`).
   */
  liveNonEmpty?: number;
}

export interface RebuildOptions {
  pageSize?: number;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * FEN-1584: geometry to reconstruct at. MUST be the ENGINE render dimensions
   * (`CANVAS_WIDTH`/`CANVAS_HEIGHT` == worker `cfg.width/height`, 512²), NOT the
   * durable F2 row dims. When omitted, falls back to the durable row's width/height
   * (legacy behaviour, exercised by the small-grid unit tests).
   */
  width?: number;
  height?: number;
  /**
   * FEN-1598 anti-wipe override. When false (the default) an empty replay
   * (`nonEmpty === 0` or no placements at all) that would clobber a POPULATED
   * live grid is ABORTED — the destructive path is refused and nothing is
   * snapshotted, because `restore.ts` is snapshot-only so the wipe is
   * irreversible. Set true only for the deliberate case where the corrected
   * source of truth really is empty and the operator wants the live grid cleared.
   */
  forceEmpty?: boolean;
  /**
   * FEN-1598 one-shot lock bypass. When false (the default) the function checks
   * `canvas:{canvasId}:rebuiltAt` AFTER resolving the durable row (so it uses
   * the Convex `_id`, not the slug) and returns early with `reason:
   * "already_rebuilt"` if the marker is set, preventing a crash-loop from
   * replaying the destructive rebuild. Set true to ignore the marker.
   */
  force?: boolean;
}

/**
 * Hard-rebuild one canvas grid from its corrected placements. Idempotent: the
 * reconstruction is a pure deterministic replay, so running it twice yields the
 * same grid (the second overwrite is a no-op change) and simply records another
 * identical snapshot.
 *
 * FEN-1598 one-shot guard: by default (`opts.force` falsy) the function checks
 * the `canvas:{_id}:rebuiltAt` marker AFTER resolving the durable row and
 * returns early with `reason: "already_rebuilt"` if it is set. The marker is
 * written on a successful rebuild so a crash-loop or forgotten `REBUILD_SLUGS`
 * env skips the destructive replay on every subsequent boot. Uses
 * `durable.canvasId` (_id) not slug, so the key lives in the canonical namespace.
 */
export async function hardRebuildFromPlacements(
  redis: Redis,
  convex: ConvexDurable,
  slug: string,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const pageSize = opts.pageSize ?? 5_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const force = opts.force ?? false;

  // The durable F2 row is required only as an EXISTENCE gate (slug-addressed,
  // ADR-0001): without a row there is nothing to rebuild — bail before touching
  // Redis.
  const durable = await convex.getCanvasDurable(slug);
  if (!durable) {
    return {
      slug,
      ok: false,
      reason: "no_durable_canvas",
      width: 0,
      height: 0,
      placements: 0,
      nonEmpty: 0,
      version: 0,
    };
  }
  // FEN-1598 ONE-SHOT LOCK — checked here (after durable resolve) so we use
  // durable.canvasId (_id) instead of slug. canvasKeys(canvasId).rebuiltAt is
  // in the canonical `canvas:{id}:*` namespace. Best-effort: a Redis error is
  // logged and the rebuild proceeds (the anti-wipe guard still protects data).
  if (!force) {
    let marker: string | null = null;
    try {
      marker = await readRebuildMarker(redis, durable.canvasId);
    } catch (err) {
      log("FEN1598 rebuild marker read failed (proceeding)", { slug, err: String(err) });
    }
    if (marker) {
      log(`FEN1598_REBUILD_SKIPPED slug=${slug} reason=already_rebuilt rebuiltAt=${marker} (set REBUILD_FORCE=1 to re-run)`);
      return {
        slug,
        ok: false,
        reason: "already_rebuilt",
        width: opts.width ?? durable.width,
        height: opts.height ?? durable.height,
        placements: 0,
        nonEmpty: 0,
        version: 0,
      };
    }
  }

  // FEN-1584: reconstruct at the ENGINE render dimensions (opts.width/height ==
  // worker cfg.width/height == CANVAS_WIDTH/HEIGHT, 512²), NOT the durable F2 dims.
  // The comingled placements live in the 512² coordinate space the gateway/worker
  // actually render; the F2 rows are incoherently small (fenysk 50×50, trishael
  // 100×100), so using them makes `reconstructPixels` treat every real coord (x up
  // to 434) as out-of-bounds → silently dropped → an EMPTY grid overwrites the live
  // canvas (the FEN-1584 regression). Fall back to the durable dims only when no
  // engine geometry is supplied (legacy unit-test path).
  const width = opts.width ?? durable.width;
  const height = opts.height ?? durable.height;

  // 1) Page ALL corrected placements from version 0 (ascending by version, so
  //    last-write-wins per cell falls out of iteration order in reconstructPixels).
  const all: PlacementRecord[] = [];
  let cursor = 0;
  for (;;) {
    const rows = await convex.getPlacementsSince(slug, cursor, pageSize);
    if (rows.length === 0) break;
    for (const r of rows) {
      all.push({ x: r.x, y: r.y, color: r.color, version: r.version, userId: r.userId, ts: r.ts });
      if (r.version > cursor) cursor = r.version;
    }
    if (rows.length < pageSize) break;
  }

  // 2) Reconstruct from an EMPTY base at snapshotVersion 0 — the whole point is to
  //    ignore any existing (stale/comingled) snapshot bitmap.
  const { pixels, version } = reconstructPixels(new Uint8Array(width * height), width, height, 0, all);
  let nonEmpty = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== 0) nonEmpty++;

  // 2b) FEN-1598 ANTI-WIPE GUARD. An empty replay (no placements, or all of them
  //     reconstruct to 0 painted cells — e.g. a too-broad reattribution, or a run
  //     launched on the wrong slug/dims) would OVERWRITE the live grid to blank and
  //     then snapshot that blank durably. `restore.ts` is snapshot-only (no
  //     pre-wipe backup), so that erasure is IRREVERSIBLE. Refuse it unless the
  //     operator explicitly forces an empty rebuild — but only when there is
  //     actually a populated grid to protect (a blank→blank rebuild loses nothing
  //     and stays a legitimate no-op, e.g. the trishael-with-placements case still
  //     has nonEmpty>0 and is unaffected).
  const replayEmpty = all.length === 0 || nonEmpty === 0;
  if (replayEmpty && !opts.forceEmpty) {
    // Use durable.canvasId for the Redis read — post FEN-1564 the live grid is
    // at canvas:{convexId}:pixels, not canvas:{slug}:pixels (FEN-1613).
    const live = await readLiveGridNonEmpty(redis, durable.canvasId);
    if (live.nonEmpty > 0) {
      log("FEN1598 rebuild ABORTED: empty replay would wipe a populated live grid", {
        slug,
        placements: all.length,
        replayNonEmpty: nonEmpty,
        liveNonEmpty: live.nonEmpty,
        hint: "set REBUILD_FORCE_EMPTY=1 only if the corrected source of truth really is empty",
      });
      return {
        slug,
        ok: false,
        reason: "empty_replay_abort",
        width,
        height,
        placements: all.length,
        nonEmpty,
        version: 0,
        liveNonEmpty: live.nonEmpty,
      };
    }
  }

  // 3) Overwrite the live Redis grid (monotonic meta — never regress the counter).
  // Use durable.canvasId (Convex _id) as the Redis namespace — post FEN-1564 the
  // gateway writes to canvas:{convexId}:* so the worker must write/read the same.
  const effectiveVersion = await overwriteCanvas(redis, durable.canvasId, pixels, version);
  log("rebuild overwrote grid", {
    slug,
    redisCanvasId: durable.canvasId,
    placements: all.length,
    nonEmpty,
    replayVersion: version,
    effectiveVersion,
  });

  // 4) Record a FRESH snapshot from the grid we just wrote, so the next cold-start
  //    restore re-hydrates the CORRECT canvas (not the stale comingled snapshot).
  try {
    const snap = await buildAndRecord(redis, convex, slug, width, height, now(), durable.canvasId);
    // FEN-1598: stamp the one-shot marker on SUCCESS (scoped to _id). Best-effort:
    // a marker write failure means a redundant idempotent replay on next boot, not
    // data loss — the grid and snapshot are already correct.
    try {
      await writeRebuildMarker(redis, durable.canvasId, now());
    } catch (err) {
      log("FEN1598 rebuild marker write failed (rebuild still succeeded)", { slug, err: String(err) });
    }
    return {
      slug,
      ok: true,
      reason: "rebuilt_from_placements",
      width,
      height,
      placements: all.length,
      nonEmpty,
      version: effectiveVersion,
      snapshotVersion: snap.version,
      snapshotBytes: snap.bytes,
    };
  } catch (err) {
    // The grid IS corrected in Redis; only the durable snapshot failed. Surface it
    // so DevOps can re-run (idempotent) rather than silently leaving a stale
    // snapshot that a future cold restore would resurrect.
    log("rebuild snapshot failed", { slug, err: String(err) });
    return {
      slug,
      ok: false,
      reason: "snapshot_failed",
      width,
      height,
      placements: all.length,
      nonEmpty,
      version: effectiveVersion,
    };
  }
}

export interface RebuildBootConfig {
  /** Slugs to rebuild once at boot (== `WorkerConfig.rebuildSlugs`). */
  slugs: string[];
  /** Engine geometry to reconstruct at (== worker `cfg.width/height`, 512²). */
  width: number;
  height: number;
  /** Whether the worker's `GATEWAY_INTERNAL_SECRET` env was non-empty at boot. */
  secretPresent: boolean;
  /** Max attempts per slug before an explicit abort (== `rebuildMaxAttempts`). */
  maxAttempts: number;
  /** Delay between attempts in ms (== `rebuildRetryDelayMs`). */
  retryDelayMs: number;
  /**
   * FEN-1598 one-shot bypass (`REBUILD_FORCE`). When false (default) a slug that
   * already carries a `canvas:{_id}:rebuiltAt` marker is SKIPPED — this is what
   * stops a crash-loop or forgotten `REBUILD_SLUGS` env from replaying the
   * destructive rebuild on every boot. Set true for a deliberate re-run despite
   * the marker. Threaded into `hardRebuildFromPlacements` via opts.force.
   */
  force: boolean;
  /**
   * FEN-1598 anti-wipe bypass (`REBUILD_FORCE_EMPTY`). Threaded into
   * `hardRebuildFromPlacements`; when false an empty replay onto a populated live
   * grid aborts instead of wiping. Set true only when the corrected source of
   * truth really is empty and the operator wants the grid cleared.
   */
  forceEmpty: boolean;
}

export interface RebuildBootDeps {
  redis: Redis;
  convex: ConvexDurable;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Injectable for tests; defaults to a real setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * FEN-1586 — orchestrate the gated boot rebuild with a BOUNDED readiness retry.
 *
 * The prod timing trap (noted in FEN-1584): the worker only
 * `depends_on convex-backend:healthy`, NOT the `convex-deploy` one-shot that seeds
 * `GATEWAY_INTERNAL_SECRET` onto the Convex deployment. On a COLD force-deploy the
 * worker can therefore boot first; `worker:run` then rejects its calls, so the old
 * single-shot rebuild soft-failed silently and only a manual restart (secret since
 * persisted) got it to run.
 *
 * Fix: a Convex-reach failure surfaces as a THROWN error from
 * `getCanvasDurable`/`getPlacementsSince` (an empty secret is the same — the guard
 * rejects), whereas a genuine "reachable but no such row" surfaces as a returned
 * `no_durable_canvas` result. So we retry a slug ONLY on a throw (up to
 * `maxAttempts`, spaced `retryDelayMs` apart), giving `convex-deploy` time to seed;
 * a returned result (ok or not) is terminal for that slug. When a slug exhausts its
 * attempts we emit an EXPLICIT, scrapeable `FEN1586_REBUILD_ABORTED` line (never a
 * silent no-op) so DevOps can retrigger in one shot — satisfying the acceptance's
 * "logue un échec explicite non-silencieux" branch when the seed never lands.
 *
 * Per-slug isolation is preserved: one slug's exhaustion never aborts the others.
 */
export async function rebuildAtBoot(cfg: RebuildBootConfig, deps: RebuildBootDeps): Promise<void> {
  if (cfg.slugs.length === 0) return;
  const { redis, convex, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxAttempts = Math.max(1, cfg.maxAttempts);

  log("=====FEN1576_REBUILD_START=====", {
    slugs: cfg.slugs,
    secretPresent: cfg.secretPresent,
    maxAttempts,
    retryDelayMs: cfg.retryDelayMs,
  });
  if (!cfg.secretPresent) {
    // The retry loop below still runs (env could be late-bound), but with an empty
    // secret every `worker:run` call is rejected, so this will almost certainly
    // exhaust into an explicit abort. Flag it up front for DevOps triage.
    log("FEN1586 rebuild: GATEWAY_INTERNAL_SECRET empty at boot — rebuild will retry then abort explicitly unless it is seeded");
  }

  for (const slug of cfg.slugs) {
    // FEN-1598 ONE-SHOT LOCK is now checked INSIDE hardRebuildFromPlacements
    // (after durable.canvasId is resolved) so the marker key uses the Convex _id
    // namespace, not slug. Pass force so the function respects the operator flag.

    let aborted = true;
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // A THROW here == Convex unreachable / not-yet-seeded / secret rejected →
        // retryable. A returned result (even ok:false no_durable_canvas or
        // already_rebuilt) is a definitive answer → stop retrying this slug.
        const r = await hardRebuildFromPlacements(redis, convex, slug, {
          log,
          width: cfg.width,
          height: cfg.height,
          forceEmpty: cfg.forceEmpty,
          force: cfg.force,
          now,
        });
        if (r.reason === "already_rebuilt") {
          // Logged by hardRebuildFromPlacements; just stop retrying this slug.
          aborted = false;
          break;
        }
        if (attempt > 1) log("FEN1586 rebuild succeeded after retry", { slug, attempt });
        log(rebuildSummary(r));
        aborted = false;
        break;
      } catch (err) {
        lastErr = String(err);
        log("FEN1586 rebuild attempt failed (Convex not seeded yet?)", {
          slug,
          attempt,
          maxAttempts,
          secretPresent: cfg.secretPresent,
          err: lastErr,
        });
        if (attempt < maxAttempts) await sleep(cfg.retryDelayMs);
      }
    }
    if (aborted) {
      // Explicit, non-silent terminal failure (acceptance branch 2). DevOps can
      // retrigger in one shot: re-set REBUILD_SLUGS + force-deploy (or restart the
      // worker once the secret is seeded) — the replay is idempotent.
      log(
        `FEN1586_REBUILD_ABORTED slug=${slug} reason=convex_unready ` +
          `attempts=${maxAttempts} secretPresent=${cfg.secretPresent} lastErr=${lastErr}`,
      );
    }
  }
  log("=====FEN1576_REBUILD_DONE=====");
}

/** Compact one-line summary for log scraping (mirrors FEN1575_SUMMARY). */
export function rebuildSummary(r: RebuildResult): string {
  return (
    `FEN1576_REBUILD slug=${r.slug} ok=${r.ok} reason=${r.reason} ` +
    `placements=${r.placements} nonEmpty=${r.nonEmpty} version=${r.version} ` +
    `snapV=${r.snapshotVersion ?? "-"} bytes=${r.snapshotBytes ?? "-"} ` +
    `geom=${r.width}x${r.height}`
  );
}
