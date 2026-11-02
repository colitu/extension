// Adaptive Connect 4 "Colitu LM": the shared vectors (colitu-panel docs/ac-model-vectors.json; the
// same file runs in the Go reference and every app) must come out to 1e-9.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lm = await import("../src/lib/colitu-lm.js");
const vectors = JSON.parse(readFileSync(new URL("./fixtures/ac-model-vectors.json", import.meta.url), "utf8"));
const tol = vectors.tolerance;
const near = (a, b) => Math.abs(a - b) <= tol;

test("xorshift32 vectors", () => {
  assert.equal(vectors.rng.length, 3);
  for (const v of vectors.rng) {
    const r = lm.createRng(v.seed);
    for (const want of v.next) assert.equal(r.next(), want, `seed ${v.seed} next`);
    const f = lm.createRng(v.seed);
    for (const want of v.floats) assert.equal(f.nextFloat(), want, `seed ${v.seed} float`);
  }
});

test("Beta sample vectors", () => {
  let count = 0;
  for (const v of vectors.beta_samples) {
    const r = lm.createRng(v.seed);
    for (const want of v.expected) {
      const got = lm.sampleBeta(r, v.alpha, v.beta);
      assert.ok(near(got, want), `seed ${v.seed}: ${got} vs ${want}`);
      count++;
    }
  }
  assert.equal(count, 16);
});

test("all 29 decision cases", () => {
  assert.equal(vectors.cases.length, 29);
  const failures = [];
  for (const c of vectors.cases) {
    const got = lm.decide(structuredClone(c.input));
    const want = c.expected;
    const check = (ok, what) => {
      if (!ok) failures.push(`${c.name}: ${what}`);
    };
    check(got.engine === want.engine, `engine ${got.engine}`);
    check(got.stale === want.stale, "stale");
    check(got.explored === want.explored, "explored");
    check(got.whitelist_none === want.whitelist_none, "whitelist_none");
    check(JSON.stringify(got.ranking || []) === JSON.stringify(want.ranking || []), `ranking ${JSON.stringify(got.ranking)} want ${JSON.stringify(want.ranking)}`);
    check((got.choice ?? null) === (want.choice ?? null), `choice ${got.choice} want ${want.choice}`);
    const wc = want.candidates || [];
    const gc = got.candidates || [];
    check(gc.length === wc.length, `candidates ${gc.length} want ${wc.length}`);
    for (let i = 0; i < Math.min(gc.length, wc.length); i++) {
      for (const k of Object.keys(wc[i].features)) check(near(gc[i].features[k], wc[i].features[k]), `[${i}] feature ${k}`);
      for (const k of ["alpha", "beta", "log_odds", "score"]) check(near(gc[i][k], wc[i][k]), `[${i}] ${k} ${gc[i][k]} want ${wc[i][k]}`);
      check(gc[i].eligible === wc[i].eligible, `[${i}] eligible`);
      check(gc[i].tier === wc[i].tier, `[${i}] tier`);
      const wt = wc[i].theta ?? null;
      const gt = gc[i].theta ?? null;
      check((wt === null) === (gt === null) && (wt === null || near(gt, wt)), `[${i}] theta ${gt} want ${wt}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("flag off, no model or an unknown version: AC 3 (no scores)", () => {
  const base = vectors.cases[0].input;
  for (const input of [
    { ...structuredClone(base), engine_enabled: false },
    { ...structuredClone(base), model: null },
    { ...structuredClone(base), model: { ...structuredClone(base.model), version: 2 } },
  ]) {
    const d = lm.decide(input);
    assert.equal(d.engine, "ac3");
    assert.equal(d.choice, null);
    assert.equal(d.candidates, null);
  }
});
