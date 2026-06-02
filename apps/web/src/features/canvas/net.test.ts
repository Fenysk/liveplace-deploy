import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeDelta, encodeSnapshot, type ServerMessage } from "@canvas/protocol";
import { CanvasNetClient, type MinimalSocket } from "./net.ts";

/** A controllable in-memory socket: tests drive `onopen`/`onmessage`/`onclose`. */
class FakeSocket implements MinimalSocket {
  binaryType = "blob";
  readyState = 1; // OPEN
  sent: string[] = [];
  onopen: ((ev: unknown) => unknown) | null = null;
  onmessage: ((ev: { data: unknown }) => unknown) | null = null;
  onclose: ((ev: unknown) => unknown) | null = null;
  onerror: ((ev: unknown) => unknown) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.(null);
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  open(): void {
    this.onopen?.(null);
  }
}

interface Harness {
  client: CanvasNetClient;
  sockets: FakeSocket[];
  events: string[];
  binaries: ArrayBuffer[];
  placement: ServerMessage[];
}

function makeHarness(opts: { ticket?: string | null } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const binaries: ArrayBuffer[] = [];
  const placement: ServerMessage[] = [];
  const client = new CanvasNetClient({
    url: "wss://host/canvas/main/ws",
    fetchTicket: async () => opts.ticket ?? null,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: () => 0, // never auto-reconnect in tests; we drive connect() manually
    handlers: {
      onWelcome: () => events.push("welcome"),
      onReconnected: () => events.push("reconnected"),
      onStatus: (s) => events.push(`status:${s}`),
      onViewerCount: (n) => events.push(`viewers:${n}`),
      onResyncRequired: () => events.push("resyncRequired"),
      onBinary: (buf) => {
        binaries.push(buf);
        // pretend the renderer applied it up to the frame's seq (bytes 1..4 BE)
        return new DataView(buf).getUint32(1);
      },
      onPlacementFrame: (m) => placement.push(m),
    },
  });
  return { client, sockets, events, binaries, placement };
}

test("welcome sets the resync cursor and fires onWelcome", async () => {
  const h = makeHarness();
  await h.client.connect();
  h.sockets[0]!.open();
  h.sockets[0]!.emit(JSON.stringify({ t: "welcome", protocolVersion: 1, width: 512, height: 512, cooldownUntil: 0, seq: 42 }));
  assert.equal(h.client.cursor, 42);
  assert.equal(h.client.ready, true);
  assert.ok(h.events.includes("welcome"));
});

test("a binary frame routes to onBinary and advances the cursor", async () => {
  const h = makeHarness();
  await h.client.connect();
  h.sockets[0]!.open();
  h.sockets[0]!.emit(JSON.stringify({ t: "welcome", protocolVersion: 1, width: 4, height: 4, cooldownUntil: 0, seq: 1 }));
  h.sockets[0]!.emit(encodeSnapshot(new Uint8Array(16), 7, 4, 4));
  assert.equal(h.binaries.length, 1);
  assert.equal(h.client.cursor, 7);
  h.sockets[0]!.emit(encodeDelta(9, [{ x: 0, y: 0, color: 5 }]));
  assert.equal(h.client.cursor, 9);
});

test("ack / error / cooldown / gauge route to the placement controller", async () => {
  const h = makeHarness();
  await h.client.connect();
  h.sockets[0]!.open();
  for (const m of [
    { t: "ack", seq: 0, cid: "a", charges: 3, max: 5, cooldownUntil: 0 },
    { t: "error", code: "banned", message: "x", cid: "b" },
    { t: "cooldown", until: 123 },
    { t: "gauge", charges: 1, max: 5, cooldownUntil: 456 },
  ]) {
    h.sockets[0]!.emit(JSON.stringify(m));
  }
  assert.deepEqual(h.placement.map((m) => m.t), ["ack", "error", "cooldown", "gauge"]);
});

test("viewerCount and resyncRequired are handled by the net layer", async () => {
  const h = makeHarness();
  await h.client.connect();
  h.sockets[0]!.open();
  h.sockets[0]!.emit(JSON.stringify({ t: "viewerCount", count: 17 }));
  h.sockets[0]!.emit(JSON.stringify({ t: "resyncRequired" }));
  assert.ok(h.events.includes("viewers:17"));
  assert.ok(h.events.includes("resyncRequired"));
});

test("a reconnect resyncs from the cursor and fires onReconnected", async () => {
  const h = makeHarness();
  await h.client.connect();
  h.sockets[0]!.open();
  h.sockets[0]!.emit(JSON.stringify({ t: "welcome", protocolVersion: 1, width: 4, height: 4, cooldownUntil: 0, seq: 1 }));
  h.sockets[0]!.emit(encodeDelta(5, [{ x: 1, y: 1, color: 2 }]));
  assert.equal(h.client.cursor, 5);

  // simulate drop + reconnect (second connect() opens a fresh socket)
  await h.client.connect();
  const s2 = h.sockets[1]!;
  s2.open();
  // on reconnect, opening sends a resync carrying the last applied seq
  assert.deepEqual(JSON.parse(s2.sent[0]!), { t: "resync", seq: 5 });
  // the gateway's welcome on a reconnect fires onReconnected (resend queue)
  s2.emit(JSON.stringify({ t: "welcome", protocolVersion: 1, width: 4, height: 4, cooldownUntil: 0, seq: 5 }));
  assert.ok(h.events.includes("reconnected"));
});

test("the auth ticket is appended as a query param", async () => {
  const seen: string[] = [];
  const client = new CanvasNetClient({
    url: "wss://host/canvas/main/ws",
    fetchTicket: async () => "T0KEN",
    socketFactory: (url) => {
      seen.push(url);
      return new FakeSocket();
    },
    setTimer: () => 0,
    handlers: {},
  });
  await client.connect();
  assert.equal(seen[0], "wss://host/canvas/main/ws?ticket=T0KEN");
});
