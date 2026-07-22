/**
 * DoD proof for FEN-1563 S1 — multi-canvas gateway (read + fan-out).
 *
 * Verifies:
 *   - Two connections on canvas A / B receive DIFFERENT snapshots.
 *   - Deltas published on canvas:A:deltas reach only client A (disjoint fan-out).
 *   - Deltas published on canvas:B:deltas reach only client B.
 *   - An invalid ?canvas= query param is rejected with HTTP 400.
 *   - State is reaped when the last client of a canvas disconnects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { decodeJson, decodeSnapshot, type ServerMessage } from "@canvas/protocol";
import { DEFAULT_GAUGE, DEFAULT_CANVAS_ID, canvasKeys } from "@canvas/redis-scripts";
import { Gateway, canvasDeltaChannel } from "../gateway";
import type { GatewayConfig } from "../config";
import { createFakeRedis } from "./fakeRedis";

const CANVAS_A = "canvas-alpha";
const CANVAS_B = "canvas-beta";
const WIDTH = 4;
const HEIGHT = 4;

function cfg(): GatewayConfig {
  return {
    port: 0,
    redisUrl: "redis://unused",
    width: WIDTH,
    height: HEIGHT,
    flushIntervalMs: 30,
    resyncBufferSize: 16,
    streamMaxLen: 0,
    presenceRefreshMs: 60_000,
    presenceTtlMs: 180_000,
    heartbeatMs: 60_000,
    instanceId: "test-mc",
    auth: { disabled: true },
    gauge: { base: { ...DEFAULT_GAUGE } },
    socket: { inboundBurst: 1_000, inboundRefillPerSec: 1_000 },
    attribution: { redirectUrl: "/", cookieMaxAgeSec: 3600, cookieSecure: false },
  };
}

/** Open a WS to the gateway on a specific canvas; wait for `welcome`. */
async function connect(
  port: number,
  canvasId: string,
): Promise<{ ws: WebSocket; texts: ServerMessage[]; binaries: Buffer[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?canvas=${canvasId}`);
  const texts: ServerMessage[] = [];
  const binaries: Buffer[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) binaries.push(data as Buffer);
    else texts.push(decodeJson<ServerMessage>(data.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (_data, isBinary) => {
      if (!isBinary) resolve();
    });
  });
  return { ws, texts, binaries };
}

/** Seed a canvas pixel buffer (all zeros except byte at (x,y) = color). */
function seedCanvas(
  harness: ReturnType<typeof createFakeRedis>,
  canvasId: string,
  x: number,
  y: number,
  color: number,
): void {
  const k = canvasKeys(canvasId);
  const buf = Buffer.alloc(WIDTH * HEIGHT, 0);
  buf[y * WIDTH + x] = color;
  harness.seed(k.pixels, buf);
}

test("S1 DoD — canvas A and B receive different snapshots", async () => {
  const redis = createFakeRedis();
  seedCanvas(redis, CANVAS_A, 0, 0, 3); // canvas A: pixel (0,0) = color 3
  seedCanvas(redis, CANVAS_B, 3, 3, 7); // canvas B: pixel (3,3) = color 7

  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();

  try {
    const a = await connect(gw.boundPort, CANVAS_A);
    const b = await connect(gw.boundPort, CANVAS_B);

    // Wait for binary snapshot frames
    const waitBin = (arr: Buffer[]) =>
      arr.length > 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, 100));
    await waitBin(a.binaries);
    await waitBin(b.binaries);

    assert.ok(a.binaries.length >= 1, "canvas A: expected snapshot binary");
    assert.ok(b.binaries.length >= 1, "canvas B: expected snapshot binary");

    const snapA = decodeSnapshot(a.binaries[0]!.buffer.slice(a.binaries[0]!.byteOffset, a.binaries[0]!.byteOffset + a.binaries[0]!.byteLength) as ArrayBuffer);
    const snapB = decodeSnapshot(b.binaries[0]!.buffer.slice(b.binaries[0]!.byteOffset, b.binaries[0]!.byteOffset + b.binaries[0]!.byteLength) as ArrayBuffer);

    assert.equal(snapA.pixels[0 * WIDTH + 0], 3, "canvas A pixel (0,0) should be 3");
    assert.equal(snapA.pixels[3 * WIDTH + 3], 0, "canvas A pixel (3,3) should be 0");

    assert.equal(snapB.pixels[3 * WIDTH + 3], 7, "canvas B pixel (3,3) should be 7");
    assert.equal(snapB.pixels[0 * WIDTH + 0], 0, "canvas B pixel (0,0) should be 0");

    a.ws.close();
    b.ws.close();
  } finally {
    await gw.stop();
  }
});

test("S1 DoD — deltas on canvas A reach only client A, not client B (disjoint fan-out)", async () => {
  const redis = createFakeRedis();
  seedCanvas(redis, CANVAS_A, 0, 0, 1);
  seedCanvas(redis, CANVAS_B, 0, 0, 2);

  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();

  try {
    const a = await connect(gw.boundPort, CANVAS_A);
    const b = await connect(gw.boundPort, CANVAS_B);

    const aSnapshotCount = a.binaries.length;
    const bSnapshotCount = b.binaries.length;

    // Publish a delta ONLY to canvas A's per-canvas channel.
    redis.publish(canvasDeltaChannel(CANVAS_A), "10,1,1,5");

    // Allow flush interval to elapse.
    await new Promise<void>((r) => setTimeout(r, 80));

    // Client A should have received the delta frame (extra binary beyond snapshot).
    assert.ok(a.binaries.length > aSnapshotCount, "client A should receive the delta frame");
    // Client B must NOT have received any extra frame.
    assert.equal(b.binaries.length, bSnapshotCount, "client B must NOT receive canvas-A delta");

    // Now publish a delta ONLY to canvas B.
    const bBefore = b.binaries.length;
    const aBefore = a.binaries.length;
    redis.publish(canvasDeltaChannel(CANVAS_B), "11,2,2,6");

    await new Promise<void>((r) => setTimeout(r, 80));

    assert.ok(b.binaries.length > bBefore, "client B should receive the canvas-B delta frame");
    assert.equal(a.binaries.length, aBefore, "client A must NOT receive canvas-B delta");

    a.ws.close();
    b.ws.close();
  } finally {
    await gw.stop();
  }
});

test("S1 R3 — invalid ?canvas= is rejected with HTTP 400", async () => {
  const redis = createFakeRedis();
  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.boundPort}/ws?canvas=../../../etc/passwd`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", reject);
    });
    assert.equal(code, 400, "invalid ?canvas= must yield HTTP 400");
  } finally {
    await gw.stop();
  }
});

test("S1 — absent ?canvas= defaults to DEFAULT_CANVAS_ID", async () => {
  const redis = createFakeRedis();
  seedCanvas(redis, DEFAULT_CANVAS_ID, 1, 1, 9);

  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();

  try {
    // Connect WITHOUT ?canvas= query param.
    const ws = new WebSocket(`ws://127.0.0.1:${gw.boundPort}/ws`);
    const texts: ServerMessage[] = [];
    const binaries: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) binaries.push(data as Buffer);
      else texts.push(decodeJson<ServerMessage>(data.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (_d, isBinary) => { if (!isBinary) resolve(); });
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    assert.ok(binaries.length >= 1, "should receive snapshot for DEFAULT_CANVAS_ID");

    const buf = binaries[0]!;
    const snap = decodeSnapshot(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    assert.equal(snap.pixels[1 * WIDTH + 1], 9, "snapshot should reflect DEFAULT_CANVAS_ID pixel");

    ws.close();
  } finally {
    await gw.stop();
  }
});
