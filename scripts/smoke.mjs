#!/usr/bin/env node
/**
 * scripts/smoke.mjs — Gate 2b automated WS live-pixel smoke (FEN-25 runbook,
 * docs/runbooks/nas-deploy.md §5).
 *
 * Drives the full wire path against a running stack, end to end:
 *
 *   web /healthz → gateway /healthz → open socket → welcome + binary snapshot
 *     → place → ack → live broadcast (the SAME pixel fanned out to a second,
 *     observer connection)
 *
 * Two connections are used on purpose: the placer (B) proves place→ack, and a
 * separate observer (A) proves the Redis-backed fan-out actually reaches OTHER
 * clients — i.e. the F7/CA1 broadcast, not just the placer echoing itself.
 *
 * ZERO dependencies: uses Node's global `fetch` and `WebSocket` (Node ≥ 22).
 * The binary frame format is the FROZEN `@canvas/protocol` contract (ADR-0002),
 * inlined here so the script runs from anywhere with no build step.
 *
 * Configuration (env):
 *   WEB_URL           web origin for the /healthz probe   (default http://localhost:3000)
 *   GATEWAY_HTTP_URL  gateway origin for its /healthz probe (default http://localhost:8080;
 *                       set EMPTY to skip — e.g. behind the proxy where only /ws is exposed)
 *   GATEWAY_WS_URL    WebSocket endpoint                   (default ws://localhost:8080)
 *   TICKET            auth token for an authenticated placement; appended as the
 *                       `?token=` query the gateway verifies (it also accepts an
 *                       `Authorization: Bearer`, but the global WebSocket can't set
 *                       headers, so we use the query param). Omit for the
 *                       GATEWAY_AUTH_DISABLED=1 anonymous-stack smoke.
 *
 * Exit code 0 + `✅ SMOKE PASSED` on success; non-zero with a one-line reason otherwise.
 */

// ── Config ────────────────────────────────────────────────────────────────────
const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
// `?? ` keeps an explicit empty string (skip the probe) distinct from "unset".
const GATEWAY_HTTP_URL = process.env.GATEWAY_HTTP_URL ?? "http://localhost:8080";
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL ?? "ws://localhost:8080";
const TICKET = process.env.TICKET ?? "";

const OVERALL_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_STEP_TIMEOUT_MS ?? 5_000);

// ── Frozen @canvas/protocol bits we need (ADR-0002) ─────────────────────────────
const OP_SNAPSHOT = 0x01;
const OP_DELTA = 0x02;
const SNAPSHOT_HEADER_BYTES = 9; // u8 op + u32 seq + u16 width + u16 height
const DELTA_HEADER_BYTES = 7; // u8 op + u32 seq + u16 count
const DELTA_RECORD_BYTES = 5; // u16 x + u16 y + u8 color

function decodeSnapshot(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== OP_SNAPSHOT) throw new Error("not a snapshot frame");
  return { seq: view.getUint32(1), width: view.getUint16(5), height: view.getUint16(7) };
}

function decodeDelta(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== OP_DELTA) throw new Error("not a delta frame");
  const seq = view.getUint32(1);
  const count = view.getUint16(5);
  const writes = [];
  let off = DELTA_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    writes.push({ x: view.getUint16(off), y: view.getUint16(off + 2), color: view.getUint8(off + 4) });
    off += DELTA_RECORD_BYTES;
  }
  return { seq, writes };
}

function binaryOpcode(buf) {
  return new DataView(buf).getUint8(0);
}

// ── Small helpers ────────────────────────────────────────────────────────────
function fail(msg) {
  console.error(`❌ SMOKE FAILED: ${msg}`);
  process.exit(1);
}

function deadline(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${label}`)), ms).unref(),
  );
}

async function probeHealth(origin, name) {
  const url = `${origin.replace(/\/$/, "")}/healthz`;
  let res;
  try {
    res = await Promise.race([fetch(url), deadline(STEP_TIMEOUT_MS, `${name} /healthz`)]);
  } catch (err) {
    fail(`${name} /healthz unreachable at ${url}: ${err.message}`);
  }
  if (!res.ok) fail(`${name} /healthz returned ${res.status} at ${url}`);
  console.log(`  ✓ ${name} /healthz → ${res.status}`);
}

/**
 * A WebSocket wrapped with a frame queue + a `waitFor(predicate)` that resolves
 * with the first (possibly already-buffered) frame matching the predicate. This
 * removes the open/message ordering races inherent to event-driven sockets.
 */
class Conn {
  constructor(name, url) {
    this.name = name;
    this.frames = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`${name}: socket error`)), { once: true });
      this.ws.addEventListener("close", (ev) =>
        reject(new Error(`${name}: closed before open (code ${ev.code} ${ev.reason || ""})`)),
        { once: true },
      );
    });
    this.ws.addEventListener("message", (ev) => this.#onFrame(ev.data));
  }

  #onFrame(data) {
    const frame =
      typeof data === "string"
        ? { kind: "json", msg: JSON.parse(data) }
        : { kind: "binary", buf: data instanceof ArrayBuffer ? data : data.buffer };
    // Hand the frame to the first interested waiter, else buffer it.
    const idx = this.waiters.findIndex((w) => w.predicate(frame));
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      w.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  waitFor(predicate, label) {
    const idx = this.frames.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(this.frames.splice(idx, 1)[0]);
    const pending = new Promise((resolve) => this.waiters.push({ predicate, resolve }));
    return Promise.race([pending, deadline(STEP_TIMEOUT_MS, `${this.name}: ${label}`)]);
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function wsUrlWithTicket() {
  if (!TICKET) return GATEWAY_WS_URL;
  return `${GATEWAY_WS_URL}${GATEWAY_WS_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(TICKET)}`;
}

const isJson = (t) => (f) => f.kind === "json" && f.msg.t === t;
const isBinaryOp = (op) => (f) => f.kind === "binary" && binaryOpcode(f.buf) === op;

// ── The smoke ──────────────────────────────────────────────────────────────────
async function run() {
  console.log(`LivePlace WS live-pixel smoke`);
  console.log(`  web=${WEB_URL}  gateway-ws=${GATEWAY_WS_URL}  auth=${TICKET ? "ticket" : "anonymous"}`);

  // 1. Health probes.
  if (WEB_URL) await probeHealth(WEB_URL, "web");
  else console.log("  · web /healthz probe skipped (WEB_URL empty)");
  if (GATEWAY_HTTP_URL) await probeHealth(GATEWAY_HTTP_URL, "gateway");
  else console.log("  · gateway /healthz probe skipped (GATEWAY_HTTP_URL empty)");

  const wsUrl = wsUrlWithTicket();
  const observer = new Conn("observer", wsUrl);
  const placer = new Conn("placer", wsUrl);

  // 2. Both sockets connect and receive welcome + binary snapshot.
  await Promise.race([Promise.all([observer.opened, placer.opened]), deadline(STEP_TIMEOUT_MS, "sockets to open")]);
  console.log("  ✓ both sockets open");

  const welcome = (await placer.waitFor(isJson("welcome"), "welcome frame")).msg;
  if (welcome.protocolVersion !== 1) fail(`unexpected protocolVersion ${welcome.protocolVersion}`);
  await observer.waitFor(isJson("welcome"), "observer welcome");
  console.log(`  ✓ welcome (protocol v${welcome.protocolVersion}, ${welcome.width}x${welcome.height}, seq=${welcome.seq})`);

  const snapFrame = await placer.waitFor(isBinaryOp(OP_SNAPSHOT), "binary snapshot");
  const snap = decodeSnapshot(snapFrame.buf);
  if (snap.width !== welcome.width || snap.height !== welcome.height) {
    fail(`snapshot dims ${snap.width}x${snap.height} disagree with welcome ${welcome.width}x${welcome.height}`);
  }
  await observer.waitFor(isBinaryOp(OP_SNAPSHOT), "observer snapshot");
  console.log(`  ✓ binary snapshot (${SNAPSHOT_HEADER_BYTES + snap.width * snap.height} bytes, seq=${snap.seq})`);

  // 3. Place a pixel and assert the ack + the live broadcast to the OTHER socket.
  const x = 1;
  const y = 1;
  const color = 5; // red — a valid non-default palette index
  const cid = `smoke-${Date.now()}`;

  // Arm the observer's delta waiter BEFORE placing so a fast (50ms) flush is not missed.
  const observedDelta = observer
    .waitFor((f) => f.kind === "binary" && binaryOpcode(f.buf) === OP_DELTA, "broadcast delta")
    .then((f) => decodeDelta(f.buf));

  placer.send({ t: "place", x, y, color, cid });

  const reply = await placer.waitFor(
    (f) => f.kind === "json" && (f.msg.t === "ack" || f.msg.t === "error" || f.msg.t === "cooldown"),
    "place reply (ack/error/cooldown)",
  );
  const m = reply.msg;
  if (m.t === "error" && m.code === "unauthenticated") {
    fail(
      "placement rejected: unauthenticated. Pass TICKET=<token> for the real ticket path, " +
        "or bring the stack up with GATEWAY_AUTH_DISABLED=1 for an anonymous stack check.",
    );
  }
  if (m.t !== "ack") fail(`place was not acked: ${m.t}${m.code ? ` (${m.code}: ${m.message})` : ""}`);
  if (m.cid !== cid) fail(`ack echoed cid "${m.cid}", expected "${cid}"`);
  console.log(`  ✓ ack (cid=${m.cid}, gauge ${m.charges}/${m.max})`);

  const delta = await observedDelta;
  const hit = delta.writes.find((w) => w.x === x && w.y === y && w.color === color);
  if (!hit) {
    fail(`observer received a delta (seq=${delta.seq}, ${delta.writes.length} writes) but not our pixel (${x},${y},${color})`);
  }
  console.log(`  ✓ live broadcast: observer saw pixel (${x},${y},color=${color}) in delta seq=${delta.seq}`);

  observer.close();
  placer.close();
  console.log("✅ SMOKE PASSED");
  process.exit(0);
}

Promise.race([run(), deadline(OVERALL_TIMEOUT_MS, "the smoke to complete")]).catch((err) => fail(err.message));
