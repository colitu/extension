// AC4 phase 1: honest server list (hiding, safeguards, ping shown while connected).
import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyReach, recordRound, hiddenIds, visible, displayPing, isUnreachable, OFF_CACHE_MS } from "../src/lib/reachability.js";

const t0 = Date.UTC(2026, 10, 2, 12);
const MIN = 60000;
const ids = ["a", "b", "c", "d", "e", "f"];
// A round in which only the listed servers fail; the rest answer in 40 ms.
const round = (failing, all = ids) => Object.fromEntries(all.map((id) => [id, failing.includes(id) ? null : 40]));
const off = (state, results, minutes = 0) => recordRound(state, results, { vpnOff: true, at: t0 + minutes * MIN });

test("two failed proxy-off rounds hide a server, one success brings it back", () => {
  let s = off(emptyReach(), round(["a"]), 0);
  assert.equal(isUnreachable(s, "a"), false);
  assert.deepEqual([...hiddenIds(s, ids)], []);
  s = off(s, round(["a"]), 30);
  assert.deepEqual([...hiddenIds(s, ids)], ["a"]);
  assert.deepEqual(visible(s, ids.map((id) => ({ id }))).map((x) => x.id), ["b", "c", "d", "e", "f"]);
  s = off(s, round([]), 60);
  assert.deepEqual([...hiddenIds(s, ids)], []);
});

test("a success between two failures resets the count", () => {
  let s = off(emptyReach(), round(["a"]), 0);
  s = off(s, round([]), 30);
  s = off(s, round(["a"]), 60);
  assert.deepEqual([...hiddenIds(s, ids)], []);
});

test("rounds with the proxy on never change reachability", () => {
  let s = emptyReach();
  for (let i = 0; i < 4; i++) s = recordRound(s, round(["a"]), { vpnOff: false, at: t0 + i * 30 * MIN });
  assert.equal(isUnreachable(s, "a"), false);
  assert.deepEqual([...hiddenIds(s, ids)], []);
});

test("nothing is hidden when every server fails (no network)", () => {
  let s = off(emptyReach(), round([]), 0);
  s = off(s, round(ids), 30);
  s = off(s, round(ids), 60);
  assert.deepEqual([...hiddenIds(s, ids)], []);
  assert.equal(isUnreachable(s, "a"), false); // such a round does not count at all
});

test("a round where half or more failed does not count, and hides nothing", () => {
  let s = off(emptyReach(), round(["a", "b", "c"]), 0);
  s = off(s, round(["a", "b", "c"]), 30);
  assert.deepEqual([...hiddenIds(s, ids)], []);
  // The network recovers: the next round (only "a" fails) starts counting from zero.
  s = off(s, round(["a"]), 60);
  assert.deepEqual([...hiddenIds(s, ids)], []);
  s = off(s, round(["a"]), 90);
  assert.deepEqual([...hiddenIds(s, ids)], ["a"]);
});

test("nothing is hidden when half of the known servers would be", () => {
  // Two of six failed in the last rounds, but earlier rounds left four unreachable.
  let s = emptyReach();
  s = off(s, round(["a", "b"]), 0);
  s = off(s, round(["a", "b"]), 30);
  assert.deepEqual([...hiddenIds(s, ids)].sort(), ["a", "b"]);
  const four = ["a", "b", "c", "d"];
  assert.deepEqual([...hiddenIds(s, four)], []); // 2 of 4
  const three = ["a", "b", "c"];
  assert.deepEqual([...hiddenIds(s, three)], []); // 2 of 3 >= 50 %
});

test("the connected or selected server is never hidden", () => {
  let s = off(emptyReach(), round(["a", "b"]), 0);
  s = off(s, round(["a", "b"]), 30);
  assert.deepEqual([...hiddenIds(s, ids, ["a"])], ["b"]);
  assert.deepEqual([...hiddenIds(s, ids, ["a", "b"])], []);
  assert.equal(visible(s, ids.map((id) => ({ id })), ["a"]).length, 5);
});

test("servers the round did not dial keep their state; gone servers are forgotten", () => {
  let s = off(emptyReach(), round(["a"]), 0);
  s = off(s, round(["a"]), 30);
  s = recordRound(s, round([], ["b", "c"]), { vpnOff: true, at: t0 + 40 * MIN, known: ["a", "b", "c", "d", "e", "f"] });
  assert.deepEqual([...hiddenIds(s, ids)], ["a"]);
  s = recordRound(s, round([], ["b"]), { vpnOff: true, at: t0 + 50 * MIN, known: ["b", "c"] });
  assert.equal(isUnreachable(s, "a"), false);
});

test("state survives a JSON round trip and is not mutated", () => {
  const before = off(emptyReach(), round(["a"]), 0);
  const copy = JSON.stringify(before);
  const after = off(before, round(["a"]), 30);
  assert.equal(JSON.stringify(before), copy);
  assert.deepEqual([...hiddenIds(JSON.parse(JSON.stringify(after)), ids)], ["a"]);
  assert.deepEqual([...hiddenIds(undefined, ids)], []);
  assert.deepEqual([...hiddenIds(null, ids)], []);
});

test("while connected: fresh live ping, else the proxy-off ping up to 30 min, else none", () => {
  const s = off(emptyReach(), round([]), 0);
  const at = t0 + 20 * MIN;
  // Measured outside the proxy a moment ago: shown.
  assert.equal(displayPing(s, "a", { live: { ms: 55, at: at - MIN }, connected: true, now: at }), 55);
  // Could not be measured while connected: last proxy-off ping (20 min old) stands in.
  assert.equal(displayPing(s, "a", { live: { ms: 12, at: t0 - 3 * 60 * MIN }, connected: true, now: at }), 40);
  assert.equal(displayPing(s, "a", { live: { ms: null, at: at - MIN }, connected: true, now: at }), 40);
  // Older than 30 min: "— ms" (null), and the server is not hidden.
  const late = t0 + OFF_CACHE_MS + MIN;
  assert.equal(displayPing(s, "a", { connected: true, now: late }), null);
  assert.deepEqual([...hiddenIds(s, ids)], []);
  // Never measured.
  assert.equal(displayPing(s, "zz", { connected: true, now: at }), null);
});

test("proxy off: the latest measurement is shown for 6 hours", () => {
  const s = emptyReach();
  assert.equal(displayPing(s, "a", { live: { ms: 70, at: t0 }, connected: false, now: t0 + 5 * 60 * MIN }), 70);
  assert.equal(displayPing(s, "a", { live: { ms: 70, at: t0 }, connected: false, now: t0 + 7 * 60 * MIN }), null);
  assert.equal(displayPing(s, "a", { live: { ms: null, at: t0 }, connected: false, now: t0 + MIN }), null);
});
