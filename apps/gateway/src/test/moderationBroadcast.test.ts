/**
 * End-to-end test for the moderation-event fan-out (FEN-156).
 *
 * A wipe reaches viewers as ordinary deltas, which carry no attribution — so the
 * gateway publishes ONE action-level event on MODERATION_EVENT_CHANNEL and every
 * instance re-broadcasts it as a `moderationEvent` frame. This drives the real
 * HTTP upgrade + WS path (fakeRedis) to prove:
 *   - a fanned-out event for THIS canvas reaches every connected viewer (authed
 *     and anonymous alike — legibility is for watchers, not just placers);
 *   - an event for a DIFFERENT canvas is ignored (multi-canvas isolation);
 *   - a malformed payload is dropped, never crashing the subscription.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { SignJWT } from "jose";
import { decodeJson, type ServerMessage } from "@canvas/protocol";
import { DEFAULT_GAUGE, DEFAULT_CANVAS_ID } from "@canvas/redis-scripts";
import { Gateway } from "../gateway";
import type { GatewayConfig } from "../config";
import { createFakeRedis } from "./fakeRedis";
import { MODERATION_EVENT_CHANNEL, encodeModerationEvent } from "../schema";

const SECRET = "test-secret-test-secret-test-secret-32";
const key = new TextEncoder().encode(SECRET);

function cfg(): GatewayConfig {
  return {
    port: 0,
    redisUrl: "redis://unused",
    width: 4,
    height: 4,
    flushIntervalMs: 50,
    resyncBufferSize: 16,
    presenceRefreshMs: 60_000,
    presenceTtlMs: 180_000,
    heartbeatMs: 60_000,
    instanceId: "test-gw",
    auth: { devSecret: SECRET, disabled: false },
    gauge: { base: { ...DEFAULT_GAUGE } },
    socket: { inboundBurst: 1_000, inboundRefillPerSec: 1_000 },
    attribution: { redirectUrl: "/", cookieMaxAgeSec: 3600, cookieSecure: false },
  };
}

async function mint(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

/** Open a socket, resolve once its `welcome` lands, and collect later text frames. */
async function connect(port: number, token?: string): Promise<{ ws: WebSocket; texts: ServerMessage[] }> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const texts: ServerMessage[] = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) texts.push(decodeJson<ServerMessage>(data.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) resolve();
    });
  });
  return { ws, texts };
}

async function waitFor(
  ws: WebSocket,
  texts: ServerMessage[],
  match: (m: ServerMessage) => boolean,
): Promise<ServerMessage> {
  const found = texts.find(match);
  if (found) return found;
  return new Promise<ServerMessage>((resolve) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const m = decodeJson<ServerMessage>(data.toString());
      if (match(m)) resolve(m);
    });
  });
}

test("a moderation event for this canvas reaches every viewer (authed + anon) — FEN-156", async () => {
  const redis = createFakeRedis();
  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();
  try {
    const authed = await connect(gw.boundPort, await mint("streamer-1"));
    const anon = await connect(gw.boundPort); // anonymous viewer

    redis.publish(
      MODERATION_EVENT_CHANNEL,
      encodeModerationEvent({ canvasId: DEFAULT_CANVAS_ID, version: 77, cells: 12 }),
    );

    const isEvent = (m: ServerMessage) => m.t === "moderationEvent";
    const a = (await waitFor(authed.ws, authed.texts, isEvent)) as Extract<ServerMessage, { t: "moderationEvent" }>;
    const b = (await waitFor(anon.ws, anon.texts, isEvent)) as Extract<ServerMessage, { t: "moderationEvent" }>;

    assert.deepEqual({ t: a.t, version: a.version, cells: a.cells }, { t: "moderationEvent", version: 77, cells: 12 });
    assert.deepEqual({ t: b.t, version: b.version, cells: b.cells }, { t: "moderationEvent", version: 77, cells: 12 });

    authed.ws.close();
    anon.ws.close();
  } finally {
    await gw.stop();
  }
});

test("a moderation event for a DIFFERENT canvas, and a malformed payload, are ignored", async () => {
  const redis = createFakeRedis();
  const gw = new Gateway(cfg(), undefined, redis.pair);
  await gw.start();
  try {
    const { ws, texts } = await connect(gw.boundPort, await mint("streamer-2"));

    // Other-canvas event + garbage payload: neither should surface here.
    redis.publish(MODERATION_EVENT_CHANNEL, encodeModerationEvent({ canvasId: "some-other-canvas", version: 5, cells: 3 }));
    redis.publish(MODERATION_EVENT_CHANNEL, "not json {");

    // Then a matching event proves the subscription is still alive after both drops.
    redis.publish(MODERATION_EVENT_CHANNEL, encodeModerationEvent({ canvasId: DEFAULT_CANVAS_ID, version: 9, cells: 1 }));
    const ev = (await waitFor(ws, texts, (m) => m.t === "moderationEvent")) as Extract<
      ServerMessage,
      { t: "moderationEvent" }
    >;
    assert.equal(ev.version, 9);

    // Exactly one moderationEvent was delivered (the other-canvas + garbage were dropped).
    assert.equal(texts.filter((m) => m.t === "moderationEvent").length, 1);
    ws.close();
  } finally {
    await gw.stop();
  }
});
