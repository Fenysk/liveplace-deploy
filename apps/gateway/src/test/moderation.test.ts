/**
 * Unit tests for the moderation internal seam (F8/FEN-19, moderation.ts). The
 * Lua behaviour itself is proven by the redis-scripts integration tests; here we
 * drive ModerationService against a recording fake `ModerationRedis` to assert it
 * issues the right Redis operations, and `parseCells` rejects malformed bodies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canvasKeys, DELTA_CHANNEL } from "@canvas/redis-scripts";
import {
  ModerationService,
  ModerationRequestError,
  parseCells,
  flushRequestChannel,
  type ModerationRedis,
} from "../moderation";
import { MODERATION_EVENT_CHANNEL, parseModerationEvent } from "../schema";

const CID = "streamerlogin";
const K = canvasKeys(CID);

/** Records every call so a test can assert the exact Redis ops + args. */
class RecordingRedis implements ModerationRedis {
  calls: Array<{ op: string; args: unknown[] }> = [];
  /** Canned moderate.lua reply: [applied, lastSeq]. */
  moderateReply: [number, number] = [0, 0];

  async evalModerate(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
    this.calls.push({ op: "evalModerate", args: [keys, argv] });
    return this.moderateReply;
  }
  async set(key: string, value: string) { this.calls.push({ op: "set", args: [key, value] }); return "OK"; }
  async del(key: string) { this.calls.push({ op: "del", args: [key] }); return 1; }
  async sadd(key: string, m: string) { this.calls.push({ op: "sadd", args: [key, m] }); return 1; }
  async srem(key: string, m: string) { this.calls.push({ op: "srem", args: [key, m] }); return 1; }
  async publish(channel: string, payload: string) { this.calls.push({ op: "publish", args: [channel, payload] }); return 0; }
}

function service(redis: ModerationRedis) {
  return new ModerationService(redis, {
    canvasId: CID, width: 100, height: 100, paletteSize: 16, now: () => 1_700_000_000_000,
  });
}

test("moderate() runs moderate.lua on the canvas keys and echoes the bumped version", async () => {
  const redis = new RecordingRedis();
  redis.moderateReply = [2, 42];
  const out = await service(redis).moderate([{ x: 1, y: 1, color: 3 }, { x: 2, y: 2, color: 0 }]);

  assert.deepEqual(out, { applied: 2, version: 42 });
  const evalCall = redis.calls.find((c) => c.op === "evalModerate")!;
  const [keys, argv] = evalCall.args as [string[], string[]];
  assert.deepEqual(keys, [K.pixels, K.meta, K.stream]); // durable stream on
  // ARGV: width, height, paletteSize, channel, actor("" = system), ts, count, triples
  assert.deepEqual(argv, [
    "100", "100", "16", DELTA_CHANNEL, "", "1700000000000", "2",
    "1", "1", "3",
    "2", "2", "0",
  ]);
});

test("moderate() announces an action-level moderationEvent when cells were applied (FEN-156)", async () => {
  const redis = new RecordingRedis();
  redis.moderateReply = [2, 42];
  await service(redis).moderate([{ x: 1, y: 1, color: 3 }, { x: 2, y: 2, color: 0 }]);

  const pub = redis.calls.find((c) => c.op === "publish");
  assert.ok(pub, "expected a moderation-event publish");
  const [channel, payload] = pub!.args as [string, string];
  assert.equal(channel, MODERATION_EVENT_CHANNEL);
  // The fanned-out event carries the canvas, the action's last write seq, and the
  // cell count — what every instance needs to push a `moderationEvent` frame.
  assert.deepEqual(parseModerationEvent(payload), { canvasId: CID, version: 42, cells: 2 });
});

test("moderate() does NOT announce when nothing was applied (malformed batch is silent)", async () => {
  const redis = new RecordingRedis();
  redis.moderateReply = [0, 0]; // applied=0 ⇒ no visual change ⇒ no event
  await service(redis).moderate([{ x: 9999, y: 9999, color: 3 }]);

  assert.equal(redis.calls.find((c) => c.op === "publish"), undefined);
});

test("setFrozen toggles the canvas:frozen flag (SET '1' / DEL)", async () => {
  const onR = new RecordingRedis();
  await service(onR).setFrozen(true);
  assert.deepEqual(onR.calls, [{ op: "set", args: [K.frozen, "1"] }]);

  const offR = new RecordingRedis();
  await service(offR).setFrozen(false);
  assert.deepEqual(offR.calls, [{ op: "del", args: [K.frozen] }]);
});

test("setBan SADD/SREMs the per-canvas ban set (CA6)", async () => {
  const banR = new RecordingRedis();
  await service(banR).setBan("user-7", true);
  assert.deepEqual(banR.calls, [{ op: "sadd", args: [K.bans, "user-7"] }]);

  const unbanR = new RecordingRedis();
  await service(unbanR).setBan("user-7", false);
  assert.deepEqual(unbanR.calls, [{ op: "srem", args: [K.bans, "user-7"] }]);
});

test("requestFlush publishes a best-effort nudge on the flush-request channel", async () => {
  const redis = new RecordingRedis();
  const ok = await service(redis).requestFlush();
  assert.equal(ok, true);
  assert.deepEqual(redis.calls, [{ op: "publish", args: [flushRequestChannel(CID), "1"] }]);
});

test("parseCells coerces a valid body and rejects malformed cells", () => {
  assert.deepEqual(parseCells([{ x: 1, y: 2, color: 3 }]), [{ x: 1, y: 2, color: 3 }]);
  assert.throws(() => parseCells("nope"), ModerationRequestError);
  assert.throws(() => parseCells([{ x: 1.5, y: 2, color: 3 }]), ModerationRequestError);
  assert.throws(() => parseCells([{ x: 1, y: 2 }]), ModerationRequestError);
});
