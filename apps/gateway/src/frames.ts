/**
 * Helpers that build the gauge-bearing server frames from a Redis gauge snapshot
 * (place / peek / grant result). The `{ charges, max, cooldownUntil }` → frame
 * mapping was written out at three sites (the two `{ t: "gauge" }` pushes in
 * gateway.ts and the placement `ack`); adding a field to the gauge meant chasing
 * all of them (audit finding 1g). Here it lives once.
 */
import type { GaugeState, ServerMessage } from "@canvas/protocol";

/** The fields every gauge snapshot (PlaceResult / PeekResult) carries. */
type GaugeSnapshot = { charges: number; max: number; cooldownUntil: number };

/** Project a gauge snapshot onto the protocol's GaugeState triple. */
export function gaugeState(snap: GaugeSnapshot): GaugeState {
  return { charges: snap.charges, max: snap.max, cooldownUntil: snap.cooldownUntil };
}

/** The unsolicited `{ t: "gauge" }` refresh frame for a gauge snapshot. */
export function gaugeFrame(snap: GaugeSnapshot): Extract<ServerMessage, { t: "gauge" }> {
  return { t: "gauge", ...gaugeState(snap) };
}
