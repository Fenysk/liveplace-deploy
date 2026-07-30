/**
 * DeltaCoalescer — collapses a burst of pixel writes into one frame per flush.
 *
 * This is the heart of CA1 (1 000 sockets receive a single delta with no extra
 * DB reads): every write that arrives on the Redis channel between flushes is
 * folded here, last-write-wins per pixel, and the gateway emits exactly one
 * binary frame per flush which is then sent verbatim to every client.
 *
 * Pure and synchronous — no Redis, no sockets — so it is unit-testable in
 * isolation.
 */
import type { PixelWrite } from "@canvas/protocol";
import type { DeltaMessage } from "./schema";

export interface CoalescedBatch {
  /** Highest write sequence folded into this batch. */
  seq: number;
  writes: PixelWrite[];
}

export class DeltaCoalescer {
  /** offset (y*width + x) → latest write for that pixel this cycle. */
  private pending = new Map<number, PixelWrite>();
  private maxSeq = 0;

  constructor(private readonly width: number) {}

  add(d: DeltaMessage): void {
    const offset = d.y * this.width + d.x;
    this.pending.set(offset, { x: d.x, y: d.y, color: d.color });
    if (d.seq > this.maxSeq) this.maxSeq = d.seq;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Drain the accumulated writes. Returns null when nothing is pending. */
  flush(): CoalescedBatch | null {
    if (this.pending.size === 0) return null;
    const batch: CoalescedBatch = {
      seq: this.maxSeq,
      writes: Array.from(this.pending.values()),
    };
    this.pending.clear();
    this.maxSeq = 0;
    return batch;
  }
}
