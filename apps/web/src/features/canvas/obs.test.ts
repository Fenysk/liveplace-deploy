import { test } from "node:test";
import assert from "node:assert/strict";
import { isObsPath, parseObsView } from "./obs.ts";

test("isObsPath recognises bare and slugged OBS routes only", () => {
  assert.equal(isObsPath("/obs"), true);
  assert.equal(isObsPath("/main/obs"), true);
  assert.equal(isObsPath("/team/event/obs"), true);
  assert.equal(isObsPath("/"), false);
  assert.equal(isObsPath("/obsidian"), false);
  assert.equal(isObsPath("/obs/extra"), false);
});

test("slug is null for the bare route and parsed for slugged routes", () => {
  assert.equal(parseObsView("/obs", "").slug, null);
  assert.equal(parseObsView("/main/obs", "").slug, "main");
  assert.equal(parseObsView("/a/b/obs", "").slug, "a/b");
});

test("background defaults to transparent (null) and parses bg/fond", () => {
  assert.equal(parseObsView("/obs", "").background, null);
  assert.equal(parseObsView("/obs", "?bg=transparent").background, null);
  assert.equal(parseObsView("/obs", "?bg=0a0a0a").background, "#0a0a0a");
  assert.equal(parseObsView("/obs", "?fond=%23123456").background, "#123456");
  assert.equal(parseObsView("/obs", "?bg=black").background, "black");
});

test("grid/grille is a truthy flag, default false", () => {
  assert.equal(parseObsView("/obs", "").grid, false);
  assert.equal(parseObsView("/obs", "?grid=1").grid, true);
  assert.equal(parseObsView("/obs", "?grille=on").grid, true);
  assert.equal(parseObsView("/obs", "?grid=0").grid, false);
});

test("zoom parses positive numbers, rejects junk", () => {
  assert.equal(parseObsView("/obs", "?zoom=8").zoom, 8);
  assert.equal(parseObsView("/obs", "?zoom=0").zoom, null);
  assert.equal(parseObsView("/obs", "?zoom=-4").zoom, null);
  assert.equal(parseObsView("/obs", "?zoom=abc").zoom, null);
});

test("crop/cadrage parses x,y,w,h and rejects malformed regions", () => {
  assert.deepEqual(parseObsView("/obs", "?crop=10,20,30,40").crop, { x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(parseObsView("/obs", "?cadrage=0,0,5,5").crop, { x: 0, y: 0, w: 5, h: 5 });
  assert.equal(parseObsView("/obs", "?crop=1,2,3").crop, null);
  assert.equal(parseObsView("/obs", "?crop=1,2,0,5").crop, null);
  assert.equal(parseObsView("/obs", "?crop=a,b,c,d").crop, null);
});
