/**
 * End-to-end HTTP/WS tests for the outreach funnel attribution routes (FEN-242).
 *
 * Drives the real gateway HTTP server + WS upgrade (devSecret auth, fakeRedis):
 *   - `GET /r?ref=XYZ` → 302 to the site with an `lp_ref` cookie + a counted visit;
 *   - a missing/invalid ref still 302s, with no cookie and no attribution;
 *   - an authenticated WS upgrade carrying the `lp_ref` cookie records a signup;
 *   - `GET /r/report` is Bearer-guarded and returns visits + signups per ref.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { SignJWT } from "jose";
import { DEFAULT_GAUGE } from "@canvas/redis-scripts";
import { Gateway } from "../gateway";
import type { GatewayConfig } from "../config";
import { createFakeRedis } from "./fakeRedis";

const SECRET = "test-secret-test-secret-test-secret-32";
const key = new TextEncoder().encode(SECRET);
const INTERNAL = "internal-secret-xyz";

function cfg(): GatewayConfig {
  return {
    port: 0,
    redisUrl: "redis://unused",
    width: 4,
    height: 4,
    flushIntervalMs: 50,
    resyncBufferSize: 16,
    streamMaxLen: 0,
    presenceRefreshMs: 60_000,
    presenceTtlMs: 180_000,
    heartbeatMs: 60_000,
    instanceId: "test-gw",
    internalSecret: INTERNAL,
    auth: { devSecret: SECRET, disabled: false },
    gauge: { base: { ...DEFAULT_GAUGE } },
    socket: { inboundBurst: 1_000, inboundRefillPerSec: 1_000 },
    attribution: { redirectUrl: "https://liveplace.tv/", cookieMaxAgeSec: 3600, cookieSecure: true },
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

/** Authenticate a WS upgrade carrying an arbitrary Cookie header, then close. */
async function connectWithCookie(port: number, token: string, cookie?: string): Promise<void> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (cookie) headers.cookie = cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (_d, isBinary) => {
      if (!isBinary) resolve(); // first text frame = welcome ⇒ upgrade accepted
    });
  });
  ws.close();
}

async function report(port: number, auth?: string): Promise<Response> {
  const headers = auth ? { authorization: auth } : undefined;
  return fetch(`http://127.0.0.1:${port}/r/report`, { headers });
}

test("GET /r counts a visit, sets lp_ref cookie, and 302s to the site", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.boundPort}/r?ref=Batch1-A`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://liveplace.tv/");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /lp_ref=batch1-a/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  } finally {
    await gw.stop();
  }
});

test("GET /r with no/invalid ref still 302s, no cookie, no attribution row", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.boundPort}/r?ref=!!!`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("set-cookie"), null);

    const rep = await report(gw.boundPort, `Bearer ${INTERNAL}`);
    assert.deepEqual(await rep.json(), { rows: [] });
  } finally {
    await gw.stop();
  }
});

test("authenticated upgrade carrying lp_ref records a signup; report tallies it", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    // Two visits to batch1-a, then the user signs in (WS upgrade) with the cookie.
    await fetch(`http://127.0.0.1:${gw.boundPort}/r?ref=batch1-a`, { redirect: "manual" });
    await fetch(`http://127.0.0.1:${gw.boundPort}/r?ref=batch1-a`, { redirect: "manual" });
    const token = await mint("user-signup-1");
    await connectWithCookie(gw.boundPort, token, "lp_ref=batch1-a");
    // Same user reconnects → must not double-count.
    await connectWithCookie(gw.boundPort, token, "lp_ref=batch1-a");

    const rep = await report(gw.boundPort, `Bearer ${INTERNAL}`);
    const body = (await rep.json()) as { rows: Array<{ ref: string; visits: number; signups: number }> };
    assert.deepEqual(body.rows, [{ ref: "batch1-a", visits: 2, signups: 1 }]);
  } finally {
    await gw.stop();
  }
});

test("anonymous upgrade with an lp_ref cookie records NO signup", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    await fetch(`http://127.0.0.1:${gw.boundPort}/r?ref=batch1-a`, { redirect: "manual" });
    // No token ⇒ anonymous viewer; cookie present but no userId to attribute.
    const ws = new WebSocket(`ws://127.0.0.1:${gw.boundPort}/ws`, { headers: { cookie: "lp_ref=batch1-a" } });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (_d, isBinary) => {
        if (!isBinary) resolve();
      });
    });
    ws.close();

    const rep = await report(gw.boundPort, `Bearer ${INTERNAL}`);
    const body = (await rep.json()) as { rows: Array<{ signups: number }> };
    assert.equal(body.rows[0]?.signups, 0);
  } finally {
    await gw.stop();
  }
});

test("GET /r/report rejects without/with-wrong Bearer secret", async () => {
  const gw = new Gateway(cfg(), undefined, createFakeRedis().pair);
  await gw.start();
  try {
    assert.equal((await report(gw.boundPort)).status, 401);
    assert.equal((await report(gw.boundPort, "Bearer nope")).status, 401);
    assert.equal((await report(gw.boundPort, `Bearer ${INTERNAL}`)).status, 200);
  } finally {
    await gw.stop();
  }
});

test("GET /r/report is 404 when no internal secret is configured", async () => {
  const c = cfg();
  c.internalSecret = undefined;
  const gw = new Gateway(c, undefined, createFakeRedis().pair);
  await gw.start();
  try {
    assert.equal((await report(gw.boundPort, "Bearer anything")).status, 404);
  } finally {
    await gw.stop();
  }
});
