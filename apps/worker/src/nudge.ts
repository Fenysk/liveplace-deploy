/**
 * The moderation flush nudge (FEN-71). The gateway publishes a best-effort
 * message on `flushRequestChannel(slug)` (FEN-19) before a mass moderation
 * action so the persistence worker drains `canvas:{slug}:stream` → Convex
 * immediately instead of waiting for its poll tick. This module is the worker's
 * side: a burst-coalescing drain runner plus the thin subscriber wiring.
 *
 * Correctness never depends on the nudge — moderate.lua streams overwrites
 * durably and in version order, so the periodic tick persists everything
 * regardless (see ModerationService.requestFlush). The nudge only narrows the
 * freshness window for Convex's "what was underneath" derivation.
 */
import { createRedisClient } from "@canvas/redis-scripts";

/**
 * Serializes an async drain so it never runs concurrently with itself, and
 * coalesces bursts: while a run is in flight, any number of `trigger()` calls
 * collapse into exactly ONE follow-up run. This is what lets a mass action that
 * publishes many nudges (or a nudge racing the periodic tick) cost at most one
 * extra drain rather than a stampede.
 *
 * `trigger()` is also the awaitable drain primitive the issue asks for: it
 * resolves only after a run that STARTED after this call completes, so a future
 * `/internal/flush` evolution could `await` a real drain and answer
 * `{awaited:true}`. (A run already in flight when `trigger()` is called may have
 * read the stream before this caller's data was committed, so we deliberately
 * wait for the NEXT run, not the in-flight one.)
 */
export class DrainCoalescer {
  private running = false;
  /** The not-yet-started run that pending triggers are waiting on, if any. */
  private next: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(private readonly run: () => Promise<void>) {}

  /** True while a drain is executing (used by shutdown to drain in-flight work). */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Ensure a drain happens at or after this call. Returns a promise resolving
   * when a run covering this trigger has finished.
   */
  trigger(): Promise<void> {
    if (!this.next) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.next = { promise, resolve };
    }
    const waiter = this.next.promise;
    if (!this.running) void this.pump();
    return waiter;
  }

  /**
   * Drive queued runs to completion one at a time. A trigger arriving during a
   * run installs a fresh `next` batch, so it gets its own subsequent run — the
   * loop keeps going until no batch is pending.
   */
  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (this.next) {
        const batch = this.next;
        // Detach BEFORE running: triggers during run() form a new batch and a
        // new run, so a nudge fired mid-drain is never silently dropped.
        this.next = null;
        try {
          await this.run();
        } catch {
          // The injected run() is expected to log its own errors; never let a
          // failed drain wedge the coalescer or reject a trigger() waiter.
        }
        batch.resolve();
      }
    } finally {
      this.running = false;
    }
  }
}

/** A live flush-request subscription; call `close()` to unsubscribe + disconnect. */
export interface FlushSubscription {
  close(): Promise<void>;
}

/**
 * Subscribe a DEDICATED Redis connection to the per-canvas flush-request channel
 * and call `onNudge` for every message. ioredis puts a connection into subscriber
 * mode once subscribed (it can no longer issue normal commands), so this MUST be
 * its own connection — never the one the drain uses for XREAD/XTRIM.
 *
 * `onNudge` is fire-and-forget here; the caller routes it through a
 * `DrainCoalescer` so bursts collapse. A subscribe failure rejects so `main` can
 * decide (the nudge is best-effort — the periodic tick still drains).
 */
export async function subscribeFlushRequests(
  redisUrl: string,
  channel: string,
  onNudge: () => void,
  log?: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<FlushSubscription> {
  const sub = createRedisClient(redisUrl);
  sub.on("message", (ch: string) => {
    if (ch === channel) onNudge();
  });
  sub.on("error", (err: Error) => log?.("flush subscriber error (ignored)", { err: String(err) }));
  await sub.subscribe(channel);
  log?.("subscribed to flush nudges", { channel });
  return {
    async close(): Promise<void> {
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* ignore — we're tearing down */
      }
      await sub.quit().catch(() => sub.disconnect());
    },
  };
}
