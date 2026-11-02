// Adaptive Connect 4 decision model ("Colitu LM"): an exact port of the panel's
// reference (colitu-panel internal/acmodel, docs/adaptive-connect-4.md "Colitu LM
// reference"), the same arithmetic as the Windows app (ColituLm.cs). Every app must
// reproduce docs/ac-model-vectors.json to 1e-9, so nothing here may be "improved":
// only + - * /, ln, 2^x, sqrt and cos, in the reference's order. Pure logic: no I/O,
// no browser APIs, no clock.
//
// Shapes (snake_case, as in the model file and the vectors):
//   model     { version, generated_at, country, weights, priors, protocol_fit, explore, halflife_h, latency_cap_ms }
//   candidate { node_id, protocol, entry_country, exit_country, whitelist_ok, recommended, hint_blocked,
//               load, latency_ms (null = unknown), history: [{ age_h, ok }] | null }
//   input     { model, model_age_h, engine_enabled, country, network_type, whitelist_mode, seed, candidates }

export const FORMAT_VERSION = 1;
export const DEFAULT_EXPLORE = 0.05;
export const DEFAULT_HALFLIFE_H = 72;
export const DEFAULT_LATENCY_CAP_MS = 1000;
// A model fetched longer ago than this is "stale": still used, and a refetch is tried.
export const STALE_AFTER_H = 6;
// Priors key of server-level evidence (probes without a protocol, server-hint votes).
export const ANY_PROTOCOL = "*";
export const ENGINE_AC3 = "ac3";
export const ENGINE_AC4 = "ac4";

export const DEFAULT_WEIGHTS = Object.freeze({
  latency: 1.0,
  own: 1.5,
  prior: 1.0,
  hint: -2.0,
  recommended: 0.25,
  load: -0.5,
  protocol_fit: 0.5,
  whitelist: 1.0,
});

const has = (obj, key) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const upper = (v) => String(v ?? "").toUpperCase();
const lower = (v) => String(v ?? "").toLowerCase();

// decay: the weight of an outcome ageH hours old, 2^(-ageH / halflifeH).
export function decay(ageH, halflifeH) {
  if (halflifeH <= 0) return 1;
  if (ageH < 0) ageH = 0;
  return Math.pow(2, -ageH / halflifeH);
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const b01 = (value) => (value ? 1 : 0);

// loadFeature: low 0, medium 0.5, high 1, unknown 0.
export function loadFeature(load) {
  return load === "medium" ? 0.5 : load === "high" ? 1 : 0;
}

// latencyFeature: 1 - ms / cap, clamped to 0..1; unknown is 0.
export function latencyFeature(ms, capMs) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return 0;
  if (!(capMs > 0)) capMs = DEFAULT_LATENCY_CAP_MS;
  return clamp01(1 - ms / capMs);
}

const usable = (pair) => Array.isArray(pair) && pair.length >= 2 && pair[0] > 0 && pair[1] > 0;

// priorFor: the panel prior [alpha, beta]: the protocol's own entry, else the
// server-level "*", else Beta(1, 1).
export function priorFor(model, country, nodeId, protocol) {
  const priors = model && model.priors;
  const nodes = has(priors, upper(country)) ? priors[upper(country)] : null;
  const protocols = nodes && has(nodes, lower(nodeId)) ? nodes[lower(nodeId)] : null;
  if (protocols && typeof protocols === "object") {
    const p = String(protocol ?? "");
    if (has(protocols, p) && usable(protocols[p])) return [protocols[p][0], protocols[p][1]];
    if (has(protocols, ANY_PROTOCOL) && usable(protocols[ANY_PROTOCOL])) return [protocols[ANY_PROTOCOL][0], protocols[ANY_PROTOCOL][1]];
  }
  return [1, 1];
}

// fit: the protocol fit for the network type, 0.5 when unknown.
export function fit(model, networkType, protocol) {
  const table = model && model.protocol_fit;
  const row = has(table, String(networkType ?? "")) ? table[String(networkType ?? "")] : null;
  if (row && has(row, String(protocol ?? "")) && typeof row[String(protocol ?? "")] === "number") {
    return clamp01(row[String(protocol ?? "")]);
  }
  return 0.5;
}

// isBridge: enters in one country and exits in another (a bridge RU -> abroad).
export function isBridge(candidate) {
  const entry = upper(candidate.entry_country);
  const exit = upper(candidate.exit_country);
  return entry.length > 0 && exit.length > 0 && entry !== exit;
}

// exitsInRussia: traffic leaves in Russia: never chosen automatically outside whitelist mode.
export function exitsInRussia(candidate) {
  return upper(candidate.exit_country) === "RU";
}

export function candidateKey(candidate) {
  return lower(candidate.node_id) + "\0" + String(candidate.protocol ?? "");
}

// ordinal: string.CompareOrdinal (UTF-16 code units, like JS operators).
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- random numbers -------------------------------------------------------------

const ZERO_SEED = 0x9e3779b9;
const WARMUP = 8;

// createRng: xorshift32 (shifts 13, 17, 5), seed 0 becomes 0x9E3779B9, the first 8
// outputs are discarded. next() is an unsigned 32-bit integer; nextFloat() is
// (next >> 8) / 2^24, in [0, 1) and exact in a double.
export function createRng(seed) {
  let state = (seed >>> 0) === 0 ? ZERO_SEED : seed >>> 0;
  const next = () => {
    let x = state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    state = x;
    return x;
  };
  for (let i = 0; i < WARMUP; i++) next();
  return { next, nextFloat: () => (next() >>> 8) / 16777216 };
}

// sampleBeta: a Thompson sample of Beta(alpha, beta) by its normal approximation,
// clamped to 0..1. Always exactly two draws, so the sequence is the same on every platform.
export function sampleBeta(rng, alpha, beta) {
  const u1 = 1 - rng.nextFloat();
  const u2 = rng.nextFloat();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const n = alpha + beta;
  const mean = alpha / n;
  const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
  return clamp01(mean + sd * z);
}

// randomSeed: a random uint32 for production decisions (the vectors fix theirs).
export function randomSeed() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

// --- the decision ---------------------------------------------------------------

function weightsOf(model) {
  const w = model.weights && typeof model.weights === "object" ? model.weights : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) out[key] = num(w[key], DEFAULT_WEIGHTS[key]);
  return out;
}

// decide: scores the candidates and picks one. Engine "ac3" (no scores) when the
// flag is off, there is no model or its version is unknown: use the AC 3 rules.
export function decide(input) {
  const model = input && input.model;
  if (!input || !input.engine_enabled || !model || model.version !== FORMAT_VERSION) {
    return { engine: ENGINE_AC3, stale: false, explored: false, whitelist_none: false, candidates: null, ranking: null, choice: null };
  }
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  let halflife = num(model.halflife_h, DEFAULT_HALFLIFE_H);
  if (halflife <= 0) halflife = DEFAULT_HALFLIFE_H;
  const latencyCap = num(model.latency_cap_ms, DEFAULT_LATENCY_CAP_MS);
  const explore = num(model.explore, DEFAULT_EXPLORE);
  const decision = {
    engine: ENGINE_AC4,
    stale: num(input.model_age_h, 0) > STALE_AFTER_H,
    explored: false,
    whitelist_none: false,
    candidates: [],
    ranking: [],
    choice: null,
  };

  // Own feature: this device's decayed successes and failures with the server on this
  // network, over all its protocols.
  const ownOk = new Map();
  const ownFail = new Map();
  for (const candidate of candidates) {
    const node = lower(candidate.node_id);
    for (const outcome of candidate.history || []) {
      const target = outcome.ok ? ownOk : ownFail;
      target.set(node, (target.get(node) || 0) + decay(outcome.age_h, halflife));
    }
  }

  let whitelistAny = false;
  if (input.whitelist_mode) {
    whitelistAny = candidates.some((c) => c.whitelist_ok);
    decision.whitelist_none = !whitelistAny;
  }
  const useWhitelist = Boolean(input.whitelist_mode) && whitelistAny;

  const w = weightsOf(model);
  for (const candidate of candidates) {
    const node = lower(candidate.node_id);
    const [priorAlpha, priorBeta] = priorFor(model, input.country, candidate.node_id, candidate.protocol);
    const ok = ownOk.get(node) || 0;
    const fail = ownFail.get(node) || 0;
    const f = {
      latency: latencyFeature(candidate.latency_ms ?? null, latencyCap),
      own: (ok + 1) / (ok + fail + 2),
      prior: priorAlpha / (priorAlpha + priorBeta),
      hint: b01(candidate.hint_blocked),
      recommended: b01(candidate.recommended),
      load: loadFeature(candidate.load),
      protocol_fit: fit(model, input.network_type, candidate.protocol),
      whitelist: b01(input.whitelist_mode && candidate.whitelist_ok),
    };
    let alpha = priorAlpha;
    let beta = priorBeta;
    for (const outcome of candidate.history || []) {
      if (outcome.ok) alpha += decay(outcome.age_h, halflife);
      else beta += decay(outcome.age_h, halflife);
    }
    const logOdds = Math.log(alpha) - Math.log(beta);
    const score =
      w.latency * f.latency + w.own * f.own + w.prior * f.prior + w.hint * f.hint + w.recommended * f.recommended +
      w.load * f.load + w.protocol_fit * f.protocol_fit + w.whitelist * f.whitelist + logOdds;
    const scored = { features: f, alpha, beta, log_odds: logOdds, score, eligible: false, tier: 0, theta: null };
    if (useWhitelist) {
      scored.eligible = Boolean(candidate.whitelist_ok);
      scored.tier = isBridge(candidate) ? 0 : 1;
    } else {
      scored.eligible = !exitsInRussia(candidate);
    }
    decision.candidates.push(scored);
  }

  const compare = (a, b) => {
    const x = decision.candidates[a];
    const y = decision.candidates[b];
    if (x.tier !== y.tier) return x.tier - y.tier;
    if (x.score !== y.score) return y.score < x.score ? -1 : 1;
    return ordinal(candidateKey(candidates[a]), candidateKey(candidates[b]));
  };

  // Array.prototype.sort is stable, like sort.SliceStable.
  decision.ranking = candidates.map((_, i) => i).filter((i) => decision.candidates[i].eligible).sort(compare);
  if (decision.ranking.length === 0) return decision;
  let choice = decision.ranking[0];

  // Exploration: one uniform draw decides; when it explores, every candidate of the best tier
  // gets a Thompson sample in key order and the highest sample wins.
  const rng = createRng(input.seed >>> 0);
  if (rng.nextFloat() < explore) {
    decision.explored = true;
    const top = decision.candidates[choice].tier;
    const pool = decision.ranking
      .filter((i) => decision.candidates[i].tier === top)
      .sort((a, b) => ordinal(candidateKey(candidates[a]), candidateKey(candidates[b])));
    let best = -1;
    for (const i of pool) {
      const theta = sampleBeta(rng, decision.candidates[i].alpha, decision.candidates[i].beta);
      decision.candidates[i].theta = theta;
      if (theta > best) {
        best = theta;
        choice = i;
      }
    }
  }
  decision.choice = choice;
  return decision;
}
