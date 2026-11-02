// Adaptive Connect 4 around the model: Russian-server rules, bridges, whitelist mode,
// the AC 3 fallback (switch off / no model), history, model cache, the engine journal.
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.chrome ??= { runtime: { getManifest: () => ({ version: "0" }) }, storage: { local: {} } };
const ac4 = await import("../src/lib/ac4.js");
const lm = await import("../src/lib/colitu-lm.js");
const { createJournal, CAPACITY } = await import("../src/lib/engine-journal.js");
const { sanitizeServers } = await import("../src/lib/api.js");
const { sanitize } = await import("../src/lib/events.js");
const { chooseAuto } = await import("../src/lib/auto.js");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const srv = (n, country, extra = {}) => ({ id: uuid(n), name: country, country, city: "", host: `n${n}.example.test`, port: 2083, load: "low", recommended: false, whitelist_ok: false, ...extra });
const MODEL = { version: 1, generated_at: "2026-11-02T03:00:00Z", country: "RU", weights: lm.DEFAULT_WEIGHTS, priors: {}, protocol_fit: {}, explore: 0, halflife_h: 72, latency_cap_ms: 1000 };
const ms = (table) => (s) => table[s.id] ?? null;
const base = { enabled: true, model: MODEL, modelFetchedAt: Date.now(), country: "RU", seed: 1 };

test("a Russian server is listed only for Russian UI or a network in Russia", () => {
  const ru = srv(1, "RU");
  const fi = srv(2, "FI");
  assert.equal(ac4.ruVisible(fi, "en", ""), true);
  assert.equal(ac4.ruVisible(ru, "en", ""), false);
  assert.equal(ac4.ruVisible(ru, "tr", "TR"), false);
  assert.equal(ac4.ruVisible(ru, "ru", ""), true);
  assert.equal(ac4.ruVisible(ru, "en", "ru"), true);
  assert.deepEqual(ac4.ruHiddenIds([ru, fi], "en", "TR"), [ru.id]);
  // the connected or selected one is never hidden
  assert.deepEqual(ac4.ruHiddenIds([ru, fi], "en", "TR", [ru.id]), []);
  assert.deepEqual(ac4.ruHiddenIds([ru, fi], "ru", ""), []);
});

test("bridges are named by the suffix in any language and are not Russian servers", () => {
  for (const name of ["Finlandiya (Köprü)", "Финляндия (Мост)", "Finland (Bridge)"]) {
    const b = srv(3, "FI", { name });
    assert.deepEqual(ac4.countries(b), { entry: "RU", exit: "FI" }, name);
    assert.equal(ac4.isBridge(b), true);
    assert.equal(ac4.exitsInRussia(b), false);
    assert.equal(ac4.ruVisible(b, "en", ""), true);
  }
  assert.equal(ac4.isBridge(srv(4, "FI", { name: "Finlandiya" })), false);
  assert.equal(ac4.isBridge(srv(5, "RU", { name: "Rusya (Köprü)" })), false);
});

test("a plain RU server is never chosen automatically, a bridge may be", () => {
  const ru = srv(1, "RU");
  const bridge = srv(2, "LV", { name: "Letonya (Köprü)" });
  const de = srv(3, "DE");
  const latency = ms({ [ru.id]: 5, [bridge.id]: 20, [de.id]: 90 });
  const p = ac4.plan({ ...base, servers: [ru, de, bridge], latencyMs: latency });
  assert.equal(p.engine, "ac4");
  assert.ok(!p.order.some((s) => s.id === ru.id));
  assert.equal(p.order[0].id, bridge.id); // fastest eligible: the bridge
  assert.equal(ac4.plan({ ...base, servers: [ru], latencyMs: latency }).order.length, 0);
});

test("whitelist mode: only whitelist_ok servers, bridges first", () => {
  const plain = srv(1, "RU", { whitelist_ok: true });
  const bridge = srv(2, "LV", { name: "Letonya (Köprü)", whitelist_ok: true });
  const de = srv(3, "DE");
  const latency = ms({ [plain.id]: 5, [bridge.id]: 300, [de.id]: 20 });
  const p = ac4.plan({ ...base, servers: [de, plain, bridge], whitelistMode: true, latencyMs: latency });
  assert.deepEqual(p.order.map((s) => s.id), [bridge.id, plain.id]);
  // nothing flagged: normal rules (and whitelist_none)
  const none = ac4.plan({ ...base, servers: [de, srv(4, "FI")], whitelistMode: true, latencyMs: ms({ [de.id]: 20 }) });
  assert.equal(none.decision.whitelist_none, true);
  assert.equal(none.order[0].id, de.id);
});

test("without a model the AC 3 rules apply; whitelist mode still keeps to whitelist servers", () => {
  const bridge = srv(2, "LV", { name: "Letonya (Köprü)", whitelist_ok: true });
  const plain = srv(1, "RU", { whitelist_ok: true });
  const de = srv(3, "DE");
  const noModel = ac4.plan({ ...base, model: null, servers: [de, bridge], latencyMs: () => null });
  assert.equal(noModel.engine, "ac3");
  assert.equal(noModel.order.length, 0);
  assert.equal(noModel.reason, "ac3_no_model");
  const wl = ac4.plan({ ...base, model: null, servers: [de, plain, bridge], whitelistMode: true, latencyMs: ms({ [plain.id]: 5, [bridge.id]: 50 }) });
  assert.deepEqual(wl.order.map((s) => s.id), [bridge.id, plain.id]);
  assert.equal(wl.reason, "ac3_whitelist");
});

test("switch off: no plan at all, the AC 3 chooser keeps its behaviour", () => {
  const servers = [srv(1, "DE"), srv(2, "FI")];
  assert.equal(ac4.plan({ ...base, enabled: false, servers }), null);
  const now = Date.now();
  const pick = chooseAuto(servers, { [servers[0].id]: { ms: 120, at: now }, [servers[1].id]: { ms: 40, at: now } }, { now });
  assert.equal(pick.server.id, servers[1].id);
  assert.equal(ac4.parseFeature({ ac_engine_4: false }), false);
  assert.equal(ac4.parseFeature({ ac_engine_4: "yes" }), null);
  assert.equal(ac4.parseFeature(null), null);
  // the meta keeps "off" unless the panel says otherwise; absent keeps the last value
  const on = ac4.mergeMeta(null, { features: { ac_engine_4: true }, country: "ru", network: "RU-AS1" }, 1000);
  assert.equal(on.enabled, true);
  assert.equal(on.country, "RU");
  const kept = ac4.mergeMeta(on, { features: null, country: "" }, 2000);
  assert.equal(kept.enabled, true);
  assert.equal(kept.country, "RU");
  assert.equal(ac4.emptyMeta().enabled, null); // a panel that never sent the switch: off
});

test("the extension never gets whitelist_ok unless the panel says true", () => {
  const out = sanitizeServers([
    { id: "a", host: "a.example.com", port: 2083 },
    { id: "b", host: "b.example.com", port: 2083, whitelist_ok: true },
    { id: "c", host: "c.example.com", port: 2083, whitelist_ok: "true" },
  ]);
  assert.deepEqual(out.map((s) => s.whitelist_ok), [false, true, false]);
});

test("whitelist rule: foreign <= 1/5 and domestic >= 2/4; it ends when the foreign set works", () => {
  assert.equal(ac4.isWhitelist(1, 2), true);
  assert.equal(ac4.isWhitelist(0, 4), true);
  assert.equal(ac4.isWhitelist(2, 4), false);
  assert.equal(ac4.isWhitelist(0, 1), false);
  const c = (foreignOk, domesticOk) => ({ foreignOk, foreignTotal: 5, domesticOk, domesticTotal: 4 });
  assert.equal(ac4.nextState(false, c(1, 3)), true);
  assert.equal(ac4.nextState(true, c(1, 0)), true); // nothing at home either: no network, not the end
  assert.equal(ac4.nextState(true, c(3, 4)), false);
  assert.equal(ac4.flag(true, c(1, 3)), "on:f1/5:d3/4");
});

test("whitelist hosts: panel list, default RU list, bad entries dropped", () => {
  assert.deepEqual(ac4.domesticSet({}, "ru"), ["ya.ru", "vk.com", "gosuslugi.ru", "mail.ru"]);
  assert.deepEqual(ac4.domesticSet({}, "TR"), []);
  assert.deepEqual(ac4.domesticSet({}, ""), []);
  const probe = ac4.parseProbe({ ru: ["Ya.ru", "bad host", "x", "127.0.0.1:80/x"], XXX: ["a.com"], tr: ["a.com.tr"], de: "no" });
  assert.deepEqual(probe, { RU: ["ya.ru"], TR: ["a.com.tr"] });
  assert.deepEqual(ac4.domesticSet(probe, "tr"), ["a.com.tr"]);
  assert.deepEqual(ac4.domesticSet(probe, "ru"), ["ya.ru"]);
});

test("the foreign set: 3 neutral hosts and the 2 fastest Colitu nodes at their own ping port", () => {
  const nodes = [srv(1, "DE", { port: 2083 }), srv(2, "FI", { port: 2096 }), srv(3, "SE"), srv(4, "RU"), srv(5, "LV", { name: "Letonya (Köprü)" }), srv(6, "NL", { whitelist_ok: true })];
  const urls = ac4.foreignTargets(nodes, ms({ [nodes[0].id]: 80, [nodes[1].id]: 30, [nodes[2].id]: 200 }));
  assert.deepEqual(urls, [
    "https://www.google.com/",
    "https://www.wikipedia.org/",
    "https://www.cloudflare.com/",
    "https://n2.example.test:2096/",
    "https://n1.example.test:2083/",
  ]);
  assert.deepEqual(ac4.domesticTargets(["ya.ru"]), ["https://ya.ru/"]);
});

test("a check counts answers within the budget", async () => {
  const answers = new Set(["https://www.google.com/", "https://ya.ru/", "https://vk.com/", "https://mail.ru/"]);
  const probe = async (url, signal) => {
    if (!answers.has(url)) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
  };
  const foreign = ["https://www.google.com/", "https://www.wikipedia.org/", "https://www.cloudflare.com/", "https://a.test:2083/", "https://b.test:2083/"];
  const domestic = ac4.domesticTargets(["ya.ru", "vk.com", "gosuslugi.ru", "mail.ru"]);
  const r = await ac4.runCheck({ foreign, domestic, probe, budgetMs: 50 });
  assert.deepEqual({ ...r, ms: 0 }, { foreignOk: 1, foreignTotal: 5, domesticOk: 3, domesticTotal: 4, ms: 0 });
  assert.equal(ac4.isWhitelist(r.foreignOk, r.domesticOk), true);
});

test("history: per network and server, faded, pruned", () => {
  const now = Date.UTC(2026, 10, 2, 12);
  let h = {};
  h = ac4.recordOutcome(h, { networkHash: "aaaa", server: "ABC", ok: true, now: now - 3600e3 });
  h = ac4.recordOutcome(h, { networkHash: "aaaa", server: "abc", ok: false, now });
  h = ac4.recordOutcome(h, { networkHash: "bbbb", server: "abc", ok: true, now });
  const o = ac4.outcomes(h, "aaaa", "abc", ac4.PROTOCOL, now);
  assert.deepEqual(o.map((x) => x.ok), [true, false]);
  assert.ok(Math.abs(o[0].age_h - 1) < 1e-9);
  assert.equal(ac4.outcomes(h, "cccc", "abc", ac4.PROTOCOL, now).length, 0);
  // 21 days and more: dropped; at most 24 per key
  let big = {};
  for (let i = 0; i < 40; i++) big = ac4.recordOutcome(big, { networkHash: "n", server: "s", ok: true, now: now - i * 1000 });
  assert.equal(ac4.outcomes(big, "n", "s", ac4.PROTOCOL, now).length, ac4.HISTORY_MAX_PER_KEY);
  const old = ac4.recordOutcome({}, { networkHash: "n", server: "s", ok: true, now: now - 22 * 24 * 3600e3 });
  assert.equal(ac4.outcomes(old, "n", "s", ac4.PROTOCOL, now).length, 0);
});

test("a device's own failures lower a server in the ranking", () => {
  const a = srv(1, "DE");
  const b = srv(2, "FI");
  const latency = ms({ [a.id]: 50, [b.id]: 60 });
  assert.equal(ac4.plan({ ...base, servers: [a, b], latencyMs: latency }).order[0].id, a.id);
  const fails = Array.from({ length: 5 }, () => ({ age_h: 1, ok: false }));
  const p = ac4.plan({ ...base, servers: [a, b], latencyMs: latency, history: (id) => (id === a.id ? fails : []) });
  assert.equal(p.order[0].id, b.id);
});

test("the model is refetched hourly, when none or of another country; never more often than every 10 minutes", () => {
  const now = Date.now();
  const fresh = { model: MODEL, fetchedAt: now - 1800e3, now, country: "RU" };
  assert.equal(ac4.modelDue({ ...fresh }), false);
  assert.equal(ac4.modelDue({ ...fresh, model: null }), true);
  assert.equal(ac4.modelDue({ ...fresh, fetchedAt: now - 3601e3 }), true);
  assert.equal(ac4.modelDue({ ...fresh, fetchedAt: now - 7 * 3600e3 }), true);
  // "stale" for the decision still starts at 6 h
  assert.equal(lm.STALE_AFTER_H, 6);
  assert.equal(ac4.modelDue({ ...fresh, country: "TR" }), true);
  assert.equal(ac4.modelDue({ ...fresh, country: "TR", lastAttempt: now - 60e3 }), false);
  assert.equal(ac4.acceptModel({ version: 1 })?.version, 1);
  assert.equal(ac4.acceptModel("x"), null);
  assert.equal(ac4.acceptModel([]), null);
});

test("the engine journal keeps the last 300 records, oldest first, as JSON", () => {
  const j = createJournal();
  for (let i = 0; i < CAPACITY + 25; i++) j.add("decision", { i }, 1000 + i);
  assert.equal(j.count, CAPACITY);
  const snap = j.snapshot();
  assert.equal(snap.length, 300);
  assert.equal(snap[0].data.i, 25);
  assert.equal(snap[299].data.i, 324);
  assert.equal(JSON.parse(j.toJson()).length, 300);
  const k = createJournal();
  k.restore(snap);
  assert.deepEqual(k.snapshot(), snap);
  k.restore([{ nope: 1 }, null, "x"]);
  assert.equal(k.count, 0);
  j.clear();
  assert.equal(j.count, 0);
});

test("the whitelist event is sent without a node, only with sane counts", () => {
  const ok = sanitize({ kind: "whitelist", state: "on", foreign_ok: 1, foreign_total: 5, domestic_ok: 3, domestic_total: 4, ms: 1234.4 });
  assert.deepEqual(ok, { kind: "whitelist", state: "on", foreign_ok: 1, foreign_total: 5, domestic_ok: 3, domestic_total: 4, ms: 1234 });
  assert.equal(sanitize({ kind: "whitelist", state: "maybe", foreign_ok: 1, foreign_total: 5, domestic_ok: 3, domestic_total: 4 }), null);
  assert.equal(sanitize({ kind: "whitelist", state: "on", foreign_ok: 6, foreign_total: 5, domestic_ok: 3, domestic_total: 4 }), null);
  assert.equal(sanitize({ kind: "whitelist", state: "on", foreign_ok: 1, foreign_total: 0, domestic_ok: 0, domestic_total: 4 }), null);
});

test("the network token: kept up to 47 h, at most 256 characters; city scope only reaches the journal", () => {
  const token = "t".repeat(256);
  const m1 = ac4.mergeMeta(null, { features: { ac_engine_4: true }, country: "RU", token }, 1000);
  assert.equal(ac4.tokenFor(m1, 2000), token);
  const m2 = ac4.mergeMeta(m1, { country: "", token: "" }, 3000); // through a node: keeps the old one
  assert.equal(ac4.tokenFor(m2, 3000), token);
  assert.equal(ac4.tokenFor(m2, 1000 + 48 * 3600e3), "");
  assert.equal(ac4.mergeMeta(null, { token: "x".repeat(257) }, 1).token, "");
  const model = { ...MODEL, city: "Moscow", prior_scope: { RU: { [uuid(1)]: { scope: "city", city: "Moscow" }, [uuid(2)]: { scope: "country" } } } };
  assert.deepEqual(ac4.priorScopeOf(model, "ru", uuid(1).toUpperCase()), { scope: "city", city: "Moscow" });
  assert.deepEqual(ac4.priorScopeOf(model, "RU", uuid(2)), { scope: "country" });
  assert.equal(ac4.priorScopeOf(model, "RU", uuid(3)), null);
  const servers = [srv(1, "DE"), srv(2, "FI")];
  const a = ac4.plan({ ...base, servers, model, latencyMs: () => 50 });
  const b = ac4.plan({ ...base, servers, model: MODEL, latencyMs: () => 50 });
  assert.deepEqual(a.decision.candidates.map((c) => c.score), b.decision.candidates.map((c) => c.score)); // journal only
  const j = ac4.journalDecision(a);
  assert.equal(j.model_city, "Moscow");
  assert.deepEqual(j.candidates[0].prior_scope, { scope: "city", city: "Moscow" });
});
