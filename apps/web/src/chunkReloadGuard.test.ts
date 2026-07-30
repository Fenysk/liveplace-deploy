import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attemptChunkReload,
  attemptSoftRetry,
  isChunkLoadError,
  recordBoundaryError,
} from "./chunkReloadGuard.ts";

describe("isChunkLoadError", () => {
  it("matches browser dynamic-import failure messages", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://liveplace.tv/assets/canvas-abc123.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/studio-def456.css",
    ]) {
      assert.equal(isChunkLoadError(new Error(message)), true, message);
    }
  });

  it("matches ChunkLoadError by name", () => {
    const err = new Error("Loading chunk 42 failed.");
    err.name = "ChunkLoadError";
    assert.equal(isChunkLoadError(err), true);
  });

  it("rejects real application errors and non-Error values", () => {
    assert.equal(isChunkLoadError(new Error("unauthenticated")), false);
    assert.equal(isChunkLoadError(new TypeError("x is not a function")), false);
    assert.equal(isChunkLoadError("Failed to fetch dynamically imported module"), false);
    assert.equal(isChunkLoadError(undefined), false);
  });
});

describe("attemptChunkReload", () => {
  function makeDeps(nowValue: { t: number }) {
    const store = new Map<string, string>();
    let reloads = 0;
    return {
      deps: {
        now: () => nowValue.t,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        reload: () => void (reloads += 1),
      },
      reloadCount: () => reloads,
    };
  }

  it("reloads on first chunk failure and stamps the guard", () => {
    const now = { t: 1_000_000 };
    const { deps, reloadCount } = makeDeps(now);
    assert.equal(attemptChunkReload(deps), true);
    assert.equal(reloadCount(), 1);
  });

  it("vetoes a second reload inside the anti-loop window", () => {
    const now = { t: 1_000_000 };
    const { deps, reloadCount } = makeDeps(now);
    assert.equal(attemptChunkReload(deps), true);
    now.t += 5_000; // page reloaded, chunk STILL failing 5s later
    assert.equal(attemptChunkReload(deps), false);
    assert.equal(reloadCount(), 1);
  });

  it("allows a reload again once the window has elapsed (next deploy)", () => {
    const now = { t: 1_000_000 };
    const { deps, reloadCount } = makeDeps(now);
    assert.equal(attemptChunkReload(deps), true);
    now.t += 31_000;
    assert.equal(attemptChunkReload(deps), true);
    assert.equal(reloadCount(), 2);
  });

  it("still reloads when sessionStorage throws (private mode)", () => {
    let reloads = 0;
    const throwing = {
      now: () => 1_000_000,
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      reload: () => void (reloads += 1),
    };
    assert.equal(attemptChunkReload(throwing), true);
    assert.equal(reloads, 1);
  });
});

describe("attemptSoftRetry (FEN-2165)", () => {
  function makeDeps(nowValue: { t: number }) {
    const store = new Map<string, string>();
    return {
      now: () => nowValue.t,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  }

  it("allows one soft retry, vetoes the second inside the window", () => {
    const now = { t: 1_000_000 };
    const deps = makeDeps(now);
    assert.equal(attemptSoftRetry(deps), true);
    now.t += 1_000; // error recurs right after the boundary reset
    assert.equal(attemptSoftRetry(deps), false);
  });

  it("uses a separate guard from the chunk reload (retry then reload both fire once)", () => {
    const now = { t: 1_000_000 };
    const store = new Map<string, string>();
    let reloads = 0;
    const deps = {
      now: () => now.t,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      reload: () => void (reloads += 1),
    };
    // Escalation ladder: soft retry → reload → red screen.
    assert.equal(attemptSoftRetry(deps), true);
    now.t += 1_000;
    assert.equal(attemptSoftRetry(deps), false);
    assert.equal(attemptChunkReload(deps), true);
    now.t += 2_000; // still failing after the reload
    assert.equal(attemptSoftRetry(deps), false);
    assert.equal(attemptChunkReload(deps), false);
    assert.equal(reloads, 1);
  });

  it("allows a retry again once the window has elapsed", () => {
    const now = { t: 1_000_000 };
    const deps = makeDeps(now);
    assert.equal(attemptSoftRetry(deps), true);
    now.t += 31_000;
    assert.equal(attemptSoftRetry(deps), true);
  });
});

describe("recordBoundaryError (FEN-2165)", () => {
  function makeStore() {
    const store = new Map<string, string>();
    return {
      store,
      deps: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
  }

  it("persists name/message/stack of the caught error", () => {
    const { store, deps } = makeStore();
    const err = new TypeError("Cannot read properties of undefined");
    recordBoundaryError("route-boundary", err, deps);
    const ring = JSON.parse(store.get("lp:last-boundary-error") ?? "[]");
    assert.equal(ring.length, 1);
    assert.equal(ring[0].source, "route-boundary");
    assert.equal(ring[0].name, "TypeError");
    assert.equal(ring[0].message, "Cannot read properties of undefined");
    assert.ok(typeof ring[0].at === "string" && ring[0].at.length > 0);
    assert.ok(ring[0].stack === null || typeof ring[0].stack === "string");
  });

  it("keeps only the last 5 entries and survives non-Error values", () => {
    const { store, deps } = makeStore();
    for (let i = 0; i < 6; i += 1) {
      recordBoundaryError("app-boundary", new Error(`boom ${i}`), deps);
    }
    recordBoundaryError("app-boundary", "string throw", deps);
    const ring = JSON.parse(store.get("lp:last-boundary-error") ?? "[]");
    assert.equal(ring.length, 5);
    assert.equal(ring[0].message, "boom 2");
    assert.equal(ring[4].message, "string throw");
    assert.equal(ring[4].name, "string");
  });

  it("no-ops silently when storage throws", () => {
    recordBoundaryError("app-boundary", new Error("x"), {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
  });
});
