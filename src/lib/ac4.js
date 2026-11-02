// Adaptive Connect 4 around the model (colitu-lm.js): the rollout switch, the
// candidates built from the server list, the server order a decision gives, the
// device's own outcome history, the model cache rules, the whitelist check and the
// Russian-server rules. Same rules as the Windows app (ColituLmEngine.cs). Pure
// logic: no browser APIs and no storage (background.js does the I/O), so it can be
// tested in Node.
//
// The extension has one transport ("webproxy") and no multihop routes, so every
// server is one candidate whose protocol is "webproxy" (the protocol its connect
// events already carry; the panel's server-level prior "*" applies otherwise).

import * as lm from "./colitu-lm.js";
import { isBridgeName } from "./servernames.js";

export const PROTOCOL = "webproxy";

const upper = (v) => String(v ?? "").trim().toUpperCase();

// --- the rollout switch and the panel's /servers extras -----------------------------

// parseFeature: features.ac_engine_4 of /servers; null when absent or not a boolean.
export function parseFeature(features) {
  return features && typeof features === "object" && typeof features.ac_engine_4 === "boolean" ? features.ac_engine_4 : null;
}

// --- countries, bridges, Russia -----------------------------------------------------

// countries: entry and exit country of a list entry. A bridge ("Finlandiya
// (Köprü)", "(Мост)", "(Bridge)"): its entry address is in Russia, its country is
// the exit's. Anything else: its own country twice. Upper case; empty when unknown.
// (The extension lists no multihop routes, so there is no route rule here.)
export function countries(server) {
  const own = upper(server && server.country);
  if (own && own !== "RU" && isBridgeName(server.name)) return { entry: "RU", exit: own };
  return { entry: own, exit: own };
}

export function isBridge(server) {
  const { entry, exit } = countries(server);
  return entry.length > 0 && exit.length > 0 && entry !== exit;
}

// exitsInRussia: a plain RU server: never chosen automatically (outside whitelist mode).
export function exitsInRussia(server) {
  return countries(server).exit === "RU";
}

// ruVisible: a server located in Russia is listed only when the extension
// speaks Russian or the network is in Russia (owner, 2026-11-02). Bridges are
// not RU servers (their country is the exit's).
export function ruVisible(server, language, networkCountry) {
  return upper(server && server.country) !== "RU" || String(language || "").toLowerCase() === "ru" || upper(networkCountry) === "RU";
}

// ruHiddenIds: ids to hide from the list for the Russian rule, never one of `keep`.
export function ruHiddenIds(servers, language, networkCountry, keep = []) {
  const kept = new Set((keep || []).map(String));
  return (servers || []).filter((s) => s && !ruVisible(s, language, networkCountry) && !kept.has(String(s.id))).map((s) => String(s.id));
}

// --- candidates and order ------------------------------------------------------------

// buildCandidates: every usable server as one candidate. latencyMs(server) -> ms | null;
// hinted: ids of servers the panel hints as blocked on this network; history(id, protocol)
// -> [{ age_h, ok }]. Returns [{ candidate, server }].
export function buildCandidates(servers, { latencyMs = () => null, hinted = [], history = () => [] } = {}) {
  const blocked = new Set((hinted || []).map((id) => String(id).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const server of servers || []) {
    if (!server || server.id === undefined || server.id === null || server.id === "" || server.alpha === true) continue;
    const key = String(server.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const { entry, exit } = countries(server);
    const ms = latencyMs(server);
    out.push({
      candidate: {
        node_id: String(server.id),
        protocol: PROTOCOL,
        entry_country: entry,
        exit_country: exit,
        whitelist_ok: server.whitelist_ok === true,
        recommended: server.recommended === true,
        hint_blocked: blocked.has(key),
        load: server.load,
        latency_ms: typeof ms === "number" ? ms : null,
        history: history(String(server.id), PROTOCOL),
      },
      server,
    });
  }
  return out;
}

// orderFrom: the servers in the order a decision tries them: the chosen candidate's
// server first, then the ranking's servers (each once).
export function orderFrom(decision, pairs) {
  const servers = [];
  const seen = new Set();
  const indexes = (decision.choice === null || decision.choice === undefined ? [] : [decision.choice]).concat(decision.ranking || []);
  for (const index of indexes) {
    if (index >= 0 && index < pairs.length && !seen.has(String(pairs[index].server.id))) {
      seen.add(String(pairs[index].server.id));
      servers.push(pairs[index].server);
    }
  }
  return servers;
}

// whitelistOrder: whitelist mode while there is no model yet (AC 3 rules): the
// whitelist_ok servers only, bridges first, then by ping. Empty when none is flagged.
export function whitelistOrder(servers, latencyMs) {
  return (servers || [])
    .filter((s) => s && s.whitelist_ok === true && s.id !== undefined && s.id !== "" && s.alpha !== true)
    .map((server, index) => ({ server, index, ms: latencyMs(server) }))
    .sort((a, b) => Number(!isBridge(a.server)) - Number(!isBridge(b.server)) || (a.ms ?? Infinity) - (b.ms ?? Infinity) || a.index - b.index)
    .map((x) => x.server);
}

// plan: one decision. Returns null when the engine is off. Otherwise
//   { engine: "ac4" | "ac3", order, input, decision, pairs, reason }
// order is the servers to try (empty with engine "ac3" unless whitelist mode names some:
// the caller then uses the AC 3 rules).
export function plan({ servers, enabled, model, modelFetchedAt, now = Date.now(), country, networkType = "other", whitelistMode = false, hinted = [], latencyMs = () => null, history = () => [], seed = 0 }) {
  if (!enabled) return null;
  const pairs = buildCandidates(servers, { latencyMs, hinted, history });
  const input = {
    model: model || null,
    model_age_h: typeof modelFetchedAt === "number" ? Math.max(0, (now - modelFetchedAt) / 3600000) : 0,
    engine_enabled: true,
    country: country || "",
    network_type: networkType,
    whitelist_mode: Boolean(whitelistMode),
    seed: seed >>> 0,
    candidates: pairs.map((p) => p.candidate),
  };
  const decision = lm.decide(input);
  if (decision.engine !== lm.ENGINE_AC4) {
    const wl = whitelistMode ? whitelistOrder(servers, latencyMs) : [];
    const reason = wl.length ? "ac3_whitelist" : !model ? "ac3_no_model" : "ac3_model_version";
    return { engine: lm.ENGINE_AC3, order: wl, input, decision, pairs, reason };
  }
  const reason = decision.choice === null ? "no_eligible" : decision.explored ? "explore" : whitelistMode && !decision.whitelist_none ? "whitelist" : "score";
  return { engine: lm.ENGINE_AC4, order: orderFrom(decision, pairs), input, decision, pairs, reason };
}

// priorScopeOf: the model's prior_scope entry ({scope:"city", city} | {scope:"country"}) of a
// node, for the journal only; null when the model names none.
export function priorScopeOf(model, country, nodeId) {
  const table = model && model.prior_scope;
  const cc = upper(country);
  const nodes = table && typeof table === "object" && Object.prototype.hasOwnProperty.call(table, cc) ? table[cc] : null;
  const id = String(nodeId ?? "").toLowerCase();
  const entry = nodes && typeof nodes === "object" && Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null;
  if (!entry || typeof entry !== "object") return null;
  return entry.scope === "city" ? { scope: "city", city: String(entry.city ?? "").slice(0, 80) } : entry.scope === "country" ? { scope: "country" } : null;
}

// journalDecision: the journal record of a plan (candidates with their scores, ranking, choice).
export function journalDecision(p, flags = {}) {
  const { input, decision, pairs } = p;
  return {
    engine: decision.engine,
    reason: p.reason,
    model_version: input.model ? input.model.version : null,
    model_generated_at: input.model ? input.model.generated_at ?? null : null,
    // City-level priors (optional model fields): journal only, the arithmetic does not change.
    model_city: input.model && typeof input.model.city === "string" ? input.model.city : null,
    model_age_h: Math.round(input.model_age_h * 100) / 100,
    stale: decision.stale,
    explored: decision.explored,
    whitelist_mode: input.whitelist_mode,
    whitelist_none: decision.whitelist_none,
    flags,
    country: input.country,
    network_type: input.network_type,
    seed: input.seed,
    candidates: pairs.map((pair, i) => ({
      node_id: pair.candidate.node_id,
      protocol: pair.candidate.protocol,
      entry: pair.candidate.entry_country,
      exit: pair.candidate.exit_country,
      latency_ms: pair.candidate.latency_ms,
      history: (pair.candidate.history || []).length,
      prior_scope: priorScopeOf(input.model, input.country, pair.candidate.node_id),
      scored: decision.candidates && i < decision.candidates.length ? decision.candidates[i] : null,
    })),
    ranking: decision.ranking,
    choice: decision.choice === null || decision.choice === undefined || decision.choice >= pairs.length ? null : { node_id: pairs[decision.choice].candidate.node_id, protocol: pairs[decision.choice].candidate.protocol },
  };
}

// --- the device's own history (never sent) --------------------------------------------

export const HISTORY_MAX_PER_KEY = 24;
export const HISTORY_MAX_RECORDS = 3000;
export const HISTORY_MAX_AGE_MS = 21 * 24 * 3600 * 1000;

// History is a plain object: "networkHash|server|protocol" -> [[unixSeconds, 1 | 0], ...] (oldest first).
export const historyKey = (networkHash, server, protocol) => `${networkHash}|${String(server).trim().toLowerCase()}|${String(protocol).trim().toLowerCase()}`;

// networkHash: 16 hex characters of the SHA-256 of the network key (the panel's
// client_network, e.g. "TR-AS9121"); the network is kept only as this hash.
export async function networkHash(networkKey) {
  const bytes = new TextEncoder().encode(String(networkKey ?? ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function pruneHistory(history, now = Date.now()) {
  const oldest = Math.floor((now - HISTORY_MAX_AGE_MS) / 1000);
  const newest = Math.floor((now + 5 * 60 * 1000) / 1000);
  const out = {};
  let total = 0;
  for (const [key, list] of Object.entries(history && typeof history === "object" ? history : {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((r) => Array.isArray(r) && typeof r[0] === "number" && r[0] >= oldest && r[0] <= newest).slice(-HISTORY_MAX_PER_KEY);
    if (kept.length) {
      out[key] = kept;
      total += kept.length;
    }
  }
  if (total > HISTORY_MAX_RECORDS) {
    // The oldest outcomes go first.
    const all = Object.values(out).flat().map((r) => r[0]).sort((a, b) => a - b);
    const cut = all[total - HISTORY_MAX_RECORDS];
    for (const key of Object.keys(out)) {
      out[key] = out[key].filter((r) => r[0] >= cut);
      if (!out[key].length) delete out[key];
    }
  }
  return out;
}

export function recordOutcome(history, { networkHash: hash, server, protocol = PROTOCOL, ok, now = Date.now() }) {
  if (!hash || server === undefined || server === null || String(server).trim() === "") return pruneHistory(history, now);
  const key = historyKey(hash, server, protocol);
  const next = { ...(history && typeof history === "object" ? history : {}) };
  next[key] = [...(Array.isArray(next[key]) ? next[key] : []), [Math.floor(now / 1000), ok ? 1 : 0]];
  return pruneHistory(next, now);
}

// outcomes: the outcomes on this network with the server and protocol, ages in hours.
export function outcomes(history, hash, server, protocol = PROTOCOL, now = Date.now()) {
  if (!hash || server === undefined || server === null || String(server).trim() === "") return [];
  const list = history && typeof history === "object" ? history[historyKey(hash, server, protocol)] : null;
  if (!Array.isArray(list)) return [];
  const seconds = Math.floor(now / 1000);
  const oldest = Math.floor((now - HISTORY_MAX_AGE_MS) / 1000);
  return list.filter((r) => Array.isArray(r) && r[0] >= oldest).map((r) => ({ age_h: Math.max(0, seconds - r[0]) / 3600, ok: r[1] === 1 }));
}

// --- the model cache ---------------------------------------------------------------------

// The model is refetched every hour (panel city/hourly model); the decision still calls it
// "stale" only after lm.STALE_AFTER_H (6 h), and the last model is used offline.
export const MODEL_FRESH_MS = 3600 * 1000;
export const MODEL_RETRY_MS = 10 * 60 * 1000;

// modelDue: a fetch is due when there is no model, it is stale, or it is of another
// country than the device's network now; never more often than MODEL_RETRY_MS.
export function modelDue({ model, fetchedAt, lastAttempt = 0, now = Date.now(), country }) {
  const cc = upper(country);
  const mc = upper(model && model.country);
  const due =
    !model ||
    typeof fetchedAt !== "number" ||
    now - fetchedAt >= MODEL_FRESH_MS ||
    fetchedAt > now + 5 * 60 * 1000 ||
    (cc.length === 2 && mc.length === 2 && cc !== mc);
  return due && now - lastAttempt >= MODEL_RETRY_MS;
}

// acceptModel: the API answer when it looks like a model file, else null.
export function acceptModel(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.version === "number" ? raw : null;
}

// --- whitelist mode ------------------------------------------------------------------------

export const FOREIGN_MAX_OK = 1;
export const DOMESTIC_MIN_OK = 2;
export const MAX_HOSTS = 8;
export const BUDGET_MS = 4000;
export const RECHECK_MS = 5 * 60 * 1000;
export const NEUTRAL_FOREIGN_HOSTS = ["www.google.com", "www.wikipedia.org", "www.cloudflare.com"];
// Used while the panel sends no whitelist_probe (same as the panel's default).
export const DEFAULT_PROBE = Object.freeze({ RU: ["ya.ru", "vk.com", "gosuslugi.ru", "mail.ru"] });

export function isWhitelist(foreignOk, domesticOk) {
  return foreignOk <= FOREIGN_MAX_OK && domesticOk >= DOMESTIC_MIN_OK;
}

// nextState: the mode after a check. It starts when the rule holds and ends only
// when the foreign set works again (nothing answering at all is no network, not the
// end of the whitelist).
export function nextState(current, check) {
  return current ? check.foreignOk <= FOREIGN_MAX_OK : isWhitelist(check.foreignOk, check.domesticOk);
}

// flag: "on:f1/5:d3/4" as the panel stores it.
export const flag = (on, c) => `${on ? "on" : "off"}:f${c.foreignOk}/${c.foreignTotal}:d${c.domesticOk}/${c.domesticTotal}`;

export function validHost(host) {
  return typeof host === "string" && host.length > 0 && host.length <= 253 && host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !host.startsWith("-") && /^[a-z0-9.-]+$/.test(host);
}

// parseProbe: whitelist_probe: country -> hosts; bad countries and host names are
// dropped (at most 20 countries, 8 hosts each).
export function parseProbe(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw).slice(0, 20)) {
    const country = upper(name);
    if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(value)) continue;
    const hosts = [...new Set(value.filter((h) => typeof h === "string").map((h) => h.trim().toLowerCase()).filter(validHost))].slice(0, MAX_HOSTS);
    if (hosts.length) out[country] = hosts;
  }
  return out;
}

// domesticSet: the domestic hosts of `country`: the panel's list, else the default; empty when none.
export function domesticSet(probe, country) {
  const cc = upper(country);
  if (cc.length !== 2) return [];
  const source = probe && Object.keys(probe).length ? probe : DEFAULT_PROBE;
  return Object.prototype.hasOwnProperty.call(source, cc) ? source[cc].slice(0, MAX_HOSTS) : [];
}

// foreignTargets: the foreign set as URLs: the 3 neutral hosts (HTTPS, port 443) plus
// the two fastest Colitu nodes outside Russia that are not whitelist servers, probed at
// their own ping address (https://host:port/, the one the latency measurement uses).
export function foreignTargets(servers, ping) {
  const nodes = (servers || [])
    .filter((s) => s && s.host && s.port && s.whitelist_ok !== true && !exitsInRussia(s) && !isBridge(s))
    .map((server, index) => ({ server, index, ms: ping(server) }))
    .sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity) || a.index - b.index);
  const seen = new Set();
  const colitu = [];
  for (const { server } of nodes) {
    const host = String(server.host).trim().toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    colitu.push(`https://${host}:${server.port}/`);
    if (colitu.length === 2) break;
  }
  return NEUTRAL_FOREIGN_HOSTS.map((h) => `https://${h}/`).concat(colitu);
}

export const domesticTargets = (hosts) => (hosts || []).slice(0, 10).map((h) => `https://${h}/`);

// runCheck: every URL of both sets in parallel within BUDGET_MS. probe(url, signal)
// resolves when the host answered (any HTTP answer counts) and rejects otherwise.
export async function runCheck({ foreign, domestic, probe, budgetMs = BUDGET_MS, clock = () => Date.now() }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const started = clock();
  const reach = async (url) => {
    try {
      await probe(url, controller.signal);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const [f, d] = await Promise.all([Promise.all(foreign.slice(0, 10).map(reach)), Promise.all(domestic.slice(0, 10).map(reach))]);
    return {
      foreignOk: f.filter(Boolean).length,
      foreignTotal: f.length,
      domesticOk: d.filter(Boolean).length,
      domesticTotal: d.length,
      ms: Math.min(Math.max(0, Math.round(clock() - started)), 600000),
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- what /servers tells the extension (kept between calls) ---------------------------------

export const META_COUNTRY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// The signed network token is valid 48 h; it is kept for at most 47 h.
export const TOKEN_MAX_AGE_MS = 47 * 3600 * 1000;
export const TOKEN_MAX_LEN = 256;

export function emptyMeta() {
  return { enabled: null, country: "", network: "", countryAt: 0, probe: {}, hinted: [], token: "", tokenAt: 0, at: 0 };
}

// tokenFor: the stored network token while it is still valid, else "".
export function tokenFor(meta, now = Date.now()) {
  const t = meta && typeof meta.token === "string" ? meta.token : "";
  return t && t.length <= TOKEN_MAX_LEN && typeof meta.tokenAt === "number" && now - meta.tokenAt <= TOKEN_MAX_AGE_MS && meta.tokenAt <= now + 60000 ? t : "";
}

// mergeMeta: the stored meta updated with a fresh serversMeta() answer. The panel sends the
// country and network key only while the request does not come through a Colitu node, and the
// switch is always present; whatever is missing now keeps its last value ("keep the last value
// while the panel cannot be reached"), the country for at most a week.
export function mergeMeta(prev, fresh, now = Date.now()) {
  const old = { ...emptyMeta(), ...(prev && typeof prev === "object" ? prev : {}) };
  const cc = upper(fresh && fresh.country);
  const known = /^[A-Z]{2}$/.test(cc);
  const probe = parseProbe(fresh && fresh.probe);
  const feature = parseFeature(fresh && fresh.features);
  const keepCountry = !known && now - old.countryAt <= META_COUNTRY_MAX_AGE_MS && /^[A-Z]{2}$/.test(old.country);
  const freshToken = fresh && typeof fresh.token === "string" && fresh.token.length > 0 && fresh.token.length <= TOKEN_MAX_LEN ? fresh.token : "";
  return {
    token: freshToken || tokenFor(old, now),
    tokenAt: freshToken ? now : tokenFor(old, now) ? old.tokenAt : 0,
    enabled: feature === null ? old.enabled : feature,
    country: known ? cc : keepCountry ? old.country : "",
    network: known ? String((fresh && fresh.network) || "") : keepCountry ? old.network : "",
    countryAt: known ? now : keepCountry ? old.countryAt : 0,
    probe: Object.keys(probe).length ? probe : old.probe && typeof old.probe === "object" ? old.probe : {},
    hinted: fresh && Array.isArray(fresh.hinted) && known ? fresh.hinted.map(String) : Array.isArray(old.hinted) ? old.hinted : [],
    at: now,
  };
}
