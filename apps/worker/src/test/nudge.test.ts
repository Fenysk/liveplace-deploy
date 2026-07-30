import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DrainCoalescer } from "../nudge.js";

/** A run() whose completion is controlled by the test via `release()`. */
function gatedRun() {
  let runs = 0;
  let gates: Array<() => void> = [];
  const fn = () =>
    new Promise<void>((resolve) => {
      runs++;
      gates.push(resolve);
    });
  return {
    fn,
    get runs() {
      return runs;
    },
    /** Resolve all currently in-flight run() promises. */
    release() {
      const g = gates;
      gates = [];
      g.forEach((r) => r());
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DrainCoalescer", () => {
  it("runs once per trigger when triggers are serial", async () => {
    const g = gatedRun();
    const c = new DrainCoalescer(g.fn);

    const p1 = c.trigger();
    assert.equal(g.runs, 1, "starts immediately");
    g.release();
    await p1;
    assert.equal(c.isRunning, false);

    const p2 = c.trigger();
    assert.equal(g.runs, 2, "a trigger after completion starts a fresh run");
    g.release();
    await p2;
    assert.equal(g.runs, 2);
  });

  it("coalesces a burst during a run into exactly ONE follow-up run", async () => {
    const g = gatedRun();
    const c = new DrainCoalescer(g.fn);

    c.trigger(); // run #1 starts and is now in flight
    assert.equal(g.runs, 1);

    // 5 nudges arrive WHILE run #1 is in flight → they must collapse to one rerun.
    const burst = [c.trigger(), c.trigger(), c.trigger(), c.trigger(), c.trigger()];
    assert.equal(g.runs, 1, "no new run starts while one is in flight");

    g.release(); // finish run #1
    await tick();
    assert.equal(g.runs, 2, "the whole burst caused exactly one follow-up run");

    g.release(); // finish run #2
    await Promise.all(burst);
    assert.equal(g.runs, 2, "no further runs queued");
    assert.equal(c.isRunning, false);
  });

  it("trigger() during a run resolves only after the NEXT run (awaitable primitive)", async () => {
    const g = gatedRun();
    const c = new DrainCoalescer(g.fn);

    const first = c.trigger(); // run #1
    let firstDone = false;
    void first.then(() => (firstDone = true));

    const during = c.trigger(); // queued behind run #1 → satisfied by run #2
    let duringDone = false;
    void during.then(() => (duringDone = true));

    g.release(); // complete run #1
    await tick();
    assert.equal(firstDone, true, "the first trigger is satisfied by run #1");
    assert.equal(duringDone, false, "a mid-run trigger is NOT satisfied by the in-flight run");
    assert.equal(g.runs, 2, "run #2 started for the mid-run trigger");

    g.release(); // complete run #2
    await during;
    assert.equal(duringDone, true);
  });

  it("a throwing run() never wedges the coalescer or rejects a waiter", async () => {
    let runs = 0;
    const c = new DrainCoalescer(async () => {
      runs++;
      throw new Error("boom");
    });

    await c.trigger(); // resolves despite the throw
    assert.equal(runs, 1);
    assert.equal(c.isRunning, false);

    await c.trigger(); // coalescer still usable afterwards
    assert.equal(runs, 2);
  });
});
