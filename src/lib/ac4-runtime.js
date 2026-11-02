// Adaptive Connect 4: the storage and network side of ac4.js (background only).
// Keys in extension storage: ac4Meta (what /servers told us), acModel (the model
// file and when it came), acHistory (this device's outcomes, never sent), whitelist
// ({ on, at }), engineJournal (the last 300 engine records), acSeed.

import { load, save } from "./store.js";
import * as api from "./api.js";
import * as ac4 from "./ac4.js";
import * as lm from "./colitu-lm.js";
import { createJournal } from "./engine-journal.js";
import { measurementState } from "./auto.js";

export const journal = createJournal();
let journalLoaded = null;
let persistTimer = null;

// loadJournal: restores the saved records once per worker start.
export function loadJournal() {
  if (!journalLoaded) {
    journalLoaded = load(["engineJournal"])
      .then(({ engineJournal }) => {
        // Records added before the load finished stay after the saved ones.
        const fresh = journal.snapshot();
        journal.restore(engineJournal);
        for (const e of fresh) journal.add(e.kind, e.data, Date.parse(e.at));
      })
      .catch(() => {});
  }
  return journalLoaded;
}

// note: adds a record and saves the journal shortly after (the worker may be unloaded any time).
export function note(kind, data) {
  journal.add(kind, data);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    save({ engineJournal: journal.snapshot() }).catch(() => {});
  }, 1500);
}

export async function readMeta() {
  const { ac4Meta } = await load(["ac4Meta"]);
  return { ...ac4.emptyMeta(), ...(ac4Meta && typeof ac4Meta === "object" ? ac4Meta : {}) };
}

export const META_MIN_INTERVAL_MS = 10 * 60 * 1000;

// refreshMeta: reads GET /servers (at most every 10 minutes unless forced) and keeps
// the merged answer; any failure keeps what was stored.
export async function refreshMeta({ force = false, now = Date.now() } = {}) {
  const prev = await readMeta();
  if (!force && now - prev.at < META_MIN_INTERVAL_MS) return prev;
  try {
    const next = ac4.mergeMeta(prev, await api.serversMeta(), now);
    await save({ ac4Meta: next });
    return next;
  } catch {
    return prev;
  }
}

let lastModelAttempt = 0;

// refreshModelIfDue: fetches the model when the switch is on and it is due (none, older
// than 6 h, another country); a failure keeps the stale model. Never throws.
export async function refreshModelIfDue(now = Date.now(), { viaProxy = false } = {}) {
  try {
    const meta = await readMeta();
    if (meta.enabled !== true) return;
    const { acModel } = await load(["acModel"]);
    const kept = acModel && typeof acModel === "object" ? acModel : {};
    if (!ac4.modelDue({ model: kept.model, fetchedAt: kept.fetchedAt, lastAttempt: lastModelAttempt, now, country: meta.country })) return;
    lastModelAttempt = now;
    // While the proxy is on, the panel takes the country (and city) from the signed network token.
    const model = ac4.acceptModel(await api.acModel(viaProxy ? ac4.tokenFor(meta, now) : ""));
    if (model) {
      await save({ acModel: { fetchedAt: now, model } });
      const scopes = model.prior_scope && typeof model.prior_scope === "object" ? Object.values(model.prior_scope).flatMap((nodes) => (nodes && typeof nodes === "object" ? Object.values(nodes) : [])) : [];
      note("model", {
        version: model.version,
        country: model.country ?? "",
        city: typeof model.city === "string" ? model.city : null,
        generated_at: model.generated_at ?? null,
        prior_scope: { city: scopes.filter((x) => x && x.scope === "city").length, country: scopes.filter((x) => x && x.scope === "country").length },
      });
    }
  } catch {
    // the stale model stays; AC 3 rules while there is none
  }
}

// context: everything a decision needs from storage.
export async function context() {
  const meta = await readMeta();
  const { acModel, acHistory, whitelist, acSeed } = await load(["acModel", "acHistory", "whitelist", "acSeed"]);
  const model = acModel && typeof acModel === "object" ? acModel : {};
  return {
    enabled: meta.enabled === true,
    meta,
    model: model.model || null,
    fetchedAt: typeof model.fetchedAt === "number" ? model.fetchedAt : undefined,
    history: acHistory && typeof acHistory === "object" ? acHistory : {},
    hash: await ac4.networkHash(meta.network || "other"),
    whitelistOn: Boolean(whitelist && whitelist.on) && meta.enabled === true,
    seed: typeof acSeed === "number" ? acSeed >>> 0 : 1,
  };
}

// newSeed: a fresh random seed for a connect's decision, kept so the popup shows the same pick.
export async function newSeed() {
  const seed = lm.randomSeed();
  await save({ acSeed: seed });
  return seed;
}

// decide: the AC 4 plan for the current servers, or null when the switch is off.
// latency: the stored { id: { ms, at } } measurements.
export function decide(ctx, servers, latency, { now = Date.now(), seed } = {}) {
  const rec = latency || {};
  return ac4.plan({
    servers,
    enabled: ctx.enabled,
    model: ctx.model,
    modelFetchedAt: ctx.fetchedAt,
    now,
    country: ctx.meta.country,
    networkType: "other",
    whitelistMode: ctx.whitelistOn,
    hinted: ctx.meta.hinted,
    latencyMs: (s) => (measurementState(rec[s.id], now) === "ok" ? rec[s.id].ms : null),
    history: (id, protocol) => ac4.outcomes(ctx.history, ctx.hash, id, protocol, now),
    seed: seed ?? ctx.seed,
  });
}

// recordOutcome: one connect outcome on this network (history + journal); only while the switch is on.
export async function recordOutcome(server, ok, reason) {
  const ctx = await context();
  if (!ctx.enabled || server === undefined || server === null) return;
  const history = ac4.recordOutcome(ctx.history, { networkHash: ctx.hash, server, protocol: ac4.PROTOCOL, ok });
  await save({ acHistory: history });
  note("outcome", { node_id: String(server), protocol: ac4.PROTOCOL, outcome: ok ? "ok" : "fail", reason: reason ?? null });
}

export async function readWhitelist() {
  const { whitelist } = await load(["whitelist"]);
  return { on: Boolean(whitelist && whitelist.on), at: whitelist && typeof whitelist.at === "number" ? whitelist.at : 0 };
}

export async function setWhitelist(on) {
  await save({ whitelist: { on: Boolean(on), at: Date.now() } });
}

// probeUrl: any HTTP answer counts as reachable (a no-cors fetch completes on it); only a
// failed connection or TLS handshake rejects. Never goes through the proxy: callers check first.
export async function probeUrl(url, signal) {
  await fetch(url, { method: "HEAD", mode: "no-cors", redirect: "manual", cache: "no-store", credentials: "omit", signal });
}

let checking = false;
let checkedAt = 0;

// whitelistCheck: one check (foreign set vs domestic set, 4 s). The caller makes sure the
// proxy is off. Returns null when skipped, else { check, was, next, flagged }.
export async function whitelistCheck({ reason, meta, servers, pingOf, recheck = false, afterFailures = false, now = Date.now(), probe = probeUrl }) {
  if (checking) return null;
  // Outside the 5-minute re-check, at most one check a minute (ping rounds can be frequent).
  if (!afterFailures && !recheck && now - checkedAt < 60000) return null;
  checking = true;
  try {
    checkedAt = now;
    const hosts = ac4.domesticSet(meta.probe, meta.country);
    if (!hosts.length) {
      note("whitelist", { reason, skipped: "no_domestic_hosts", country: meta.country || null });
      return null;
    }
    const check = await ac4.runCheck({ foreign: ac4.foreignTargets(servers, pingOf), domestic: ac4.domesticTargets(hosts), probe });
    const was = (await readWhitelist()).on;
    const next = ac4.nextState(was, check);
    note("whitelist", {
      reason,
      foreign_ok: check.foreignOk,
      foreign_total: check.foreignTotal,
      domestic_ok: check.domesticOk,
      domestic_total: check.domesticTotal,
      ms: check.ms,
      was,
      state: next ? "on" : "off",
      flag: ac4.flag(next, check),
    });
    return { check, was, next, flagged: (servers || []).filter((s) => s && s.whitelist_ok === true).length };
  } finally {
    checking = false;
  }
}
