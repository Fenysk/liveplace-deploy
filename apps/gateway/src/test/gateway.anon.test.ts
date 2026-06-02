/**
 * End-to-end gateway tests for the anonymous read-only visitor (FEN-53 / CA5).
 *
 * Drives the real HTTP upgrade + WebSocket path (devSecret auth, fakeRedis) to
 * prove the two contract behaviours of docs/contracts/auth-flow.md:
 *   - a tokenless upgrade is admitted as an anonymous viewer, gets `welcome`,
 *     and is refused `place` with `error { code: "unauthenticated" }`;
 *   - a present-but-invalid token still has its upgrade refused (`401`);
 *   - a valid token reaches the placement path as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SignJWT } from "jose";
import { decodeJson, encodeJson, type ClientMessage, type ServerMessage } from "@canvas/protocol";
import { DEFAULT_GAUGE } from "@canvas/redis-scripts";
import { Gateway, type Connection, type PlacementHandler } from "../gateway";
import type { GatewayConfig } from "../config";
import { createFakeRedis } from "./fakeRedis";

const SECRET = "test-secret-test-secret-test-secret-32";
const key = new TextEncoder().encode(SECRET);

function cfg(): GatewayConfig {
  return {
    port: 0, // ephemeral; read back via boundPort
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
    // Generous so the e2e flow never trips the rate limiter (G-I2 has its own test).
    socket: { inboundBurst: 1_000, inboundRefillPerSec: 1_000 },
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

/** Open a socket, wait for the `welcome` text frame, and collect later text frames. */
async function connect(
  port: number,
  opts: { token?: string } = {},
): Promise<{ ws: WebSocket; texts: ServerMessage[] }> {
  const headers = opts.token ? { authorization: `Bearer ${opts.token}` } : undefined;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const texts: ServerMessage[] = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) texts.push(decodeJson<ServerMessage>(data.toString()));
  });
  // Resolves on the first text frame (welcome) or rejects if the upgrade is refused.
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) resolve();
    });
  });
  return { ws, texts };
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(encodeJson(msg));
}

/** Wait until `texts` contains a message matching the predicate. */
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

test("tokenless visitor is admitted read-only: welcome, then place ⇒ unauthenticated (CA5)", async () => {
  const placed: string[] = [];
  const handler: PlacementHandler = {
    async handlePlace(conn: Connection) {
      placed.push(String(conn.user.userId));
    },
  };
  const gw = new Gateway(cfg(), handler, createFakeRedis().pair);
  await gw.start();
  try {
    const { ws, texts } = await connect(gw.boundPort); // no token
    const welcome = await waitFor(ws, texts, (m) => m.t === "welcome");
    assert.equal(welcome.t, "welcome");

    send(ws, { t: "place", x: 1, y: 1, color: 3, seq: 42 });
    const err = await waitFor(ws, texts, (m) => m.t === "error");
    assert.deepEqual(err, {
      t: "error",
      code: "unauthenticated",
      message: "sign in to place pixels",
      seq: 42,
    });
    assert.deepEqual(placed, [], "anonymous place must never reach the placement handler");
    ws.close();
  } finally {
    await gw.stop();
  }
});

test("invalid token ⇒ upgrade refused (no silent downgrade to anonymous)", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-x")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-totally-different-secret-cccccccccc"));
    const ws = new WebSocket(`ws://127.0.0.1:${gw.boundPort}/ws`, {
      headers: { authorization: `Bearer ${bad}` },
    });
    const [err] = (await once(ws, "error")) as [Error];
    assert.match(err.message, /401/);
  } finally {
    await gw.stop();
  }
});

test("valid token reaches the placement path with its userId", async () => {
  const placed: string[] = [];
  const handler: PlacementHandler = {
    async handlePlace(conn: Connection) {
      placed.push(String(conn.user.userId));
    },
  };
  const gw = new Gateway(cfg(), handler, createFakeRedis().pair);
  await gw.start();
  try {
    const token = await mint("user-7");
    const { ws, texts } = await connect(gw.boundPort, { token });
    await waitFor(ws, texts, (m) => m.t === "welcome");
    send(ws, { t: "place", x: 0, y: 0, color: 1 });
    // Give the message a tick to be handled by the (recording) placement handler.
    await waitForCondition(() => placed.length > 0);
    assert.deepEqual(placed, ["user-7"]);
    ws.close();
  } finally {
    await gw.stop();
  }
});

/** Poll a predicate to true (used for the fire-and-forget placement handler). */
async function waitForCondition(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}
