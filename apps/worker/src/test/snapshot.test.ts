import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSnapshot, type SnapshotState } from "../snapshot.js";

const policy = { intervalMs: 60_000, everyNVersions: 5_000 };

describe("shouldSnapshot", () => {
  it("never snapshots when the canvas has not advanced", () => {
    const state: SnapshotState = { lastVersion: 100, lastAtMs: 0 };
    assert.equal(shouldSnapshot(100, state, policy, 10_000_000), false);
    assert.equal(shouldSnapshot(50, state, policy, 10_000_000), false);
  });

  it("snapshots once the interval elapsed and the version advanced", () => {
    const state: SnapshotState = { lastVersion: 100, lastAtMs: 0 };
    assert.equal(shouldSnapshot(101, state, policy, 30_000), false, "too soon, too few");
    assert.equal(shouldSnapshot(101, state, policy, 60_000), true, "interval elapsed");
  });

  it("snapshots early once enough versions accrued, regardless of time", () => {
    const state: SnapshotState = { lastVersion: 100, lastAtMs: 0 };
    assert.equal(shouldSnapshot(100 + 5_000, state, policy, 1), true);
  });
});
