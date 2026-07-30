/**
 * SeqRingBuffer — a bounded window of the most recent writes, keyed by their
 * global sequence, used to serve incremental reconnect-resync (CA2).
 *
 * Every write this instance sees on the delta channel is pushed here. When a
 * client reconnects with the last seq it applied, `since(seq)` returns exactly
 * the writes it missed — provided they are still in the window. If the client
 * fell too far behind (or reconnected to a fresh instance whose window does not
 * reach back that far), `since` returns null and the gateway falls back to a
 * full snapshot.
 *
 * Correctness rests on contiguity: because every write flows through here in
 * seq order, the buffer holds a gap-free run [oldestSeq .. newestSeq]. The one
 * way to break contiguity is missing writes during a subscriber outage, so the
 * gateway calls reset() on every Redis (re)subscribe to force snapshot fallback
 * rather than serve an incomplete replay.
 *
 * Pure and synchronous — unit-testable in isolation.
 */
import type { DeltaMessage } from "./schema";

export class SeqRingBuffer {
  private readonly buf: DeltaMessage[] = [];
  private newestSeq = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("ring buffer capacity must be >= 1");
  }

  push(d: DeltaMessage): void {
    this.buf.push(d);
    if (this.buf.length > this.capacity) this.buf.shift();
    if (d.seq > this.newestSeq) this.newestSeq = d.seq;
  }

  /** Clear the window — call on subscriber (re)connect to drop a possible gap. */
  reset(): void {
    this.buf.length = 0;
    this.newestSeq = 0;
  }

  get latestSeq(): number {
    return this.newestSeq;
  }

  private get oldestSeq(): number {
    return this.buf.length > 0 ? this.buf[0]!.seq : 0;
  }

  /**
   * Writes with seq > `seq`, in order, or null if an incremental replay can't
   * be guaranteed complete (the client is older than our window). An empty
   * array means the client is already caught up.
   */
  since(seq: number): DeltaMessage[] | null {
    if (seq >= this.newestSeq) return []; // caught up (or ahead — treat as caught up)
    // We can serve only if our window reaches back to the write right after `seq`.
    if (this.buf.length === 0 || seq + 1 < this.oldestSeq) return null;
    return this.buf.filter((d) => d.seq > seq);
  }
}
