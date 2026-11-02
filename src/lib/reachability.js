// Adaptive Connect 4, phase 1 ("honest server list"): which servers the list and
// the automatic choice may show, and which ping a row shows. Pure logic (no
// browser APIs, no timers) over a plain JSON state kept in storage.local under
// "reach", so it can be tested and survives the background being unloaded.
// Same rules as the Windows app (ColituReachability.cs).
//
//  - Only rounds measured with the proxy OFF decide reachability. A server is
//    unreachable after FAILED_ROUNDS_TO_HIDE consecutive failed rounds (each round
//    already retries once) and reachable again after one successful measurement.
//  - Safeguards: a round in which every server, or half of them or more, failed
//    says the network is the problem: it does not count, and while the last such
//    round stands nothing is hidden. Nothing is hidden either when half of the
//    known servers or more would be. The servers in `keep` (connected, selected)
//    are never hidden.
//  - With the proxy ON: a fresh ping measured outside the proxy is shown; else
//    the last one measured with the proxy off if it is at most OFF_CACHE_MS old;
//    else none ("— ms"). Nothing measured with the proxy on hides a server.

export const FAILED_ROUNDS_TO_HIDE = 2;
export const OFF_CACHE_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 400;

export function emptyReach() {
  return { entries: {}, suspect: false };
}

function sane(state) {
  const entries = state && typeof state === "object" && state.entries && typeof state.entries === "object" ? state.entries : {};
  return { entries, suspect: Boolean(state && state.suspect) };
}

const good = (ms) => typeof ms === "number" && ms > 0;
const entryOf = (state, id) => (typeof id === "string" || typeof id === "number" ? sane(state).entries[String(id)] : undefined);

// recordRound: one ping round. results: { id: ms | null } for every server the
// round actually dialled (servers not dialled are left out). vpnOff: measured
// with the proxy off; only such rounds change reachability and the off cache.
// known: ids of the servers the session lists now; the others are forgotten.
// Returns the new state (the argument is not changed).
export function recordRound(state, results, { vpnOff = false, at = Date.now(), known = null } = {}) {
  const prev = sane(state);
  const entries = {};
  for (const [id, e] of Object.entries(prev.entries)) {
    if (!known || known.map(String).includes(id)) entries[id] = { ...e };
  }
  const ids = Object.keys(results || {}).filter(Boolean);
  const failed = ids.filter((id) => !good(results[id])).length;
  const suspect = ids.length === 0 || failed * 2 >= ids.length;
  for (const id of ids) {
    const e = entries[id] || (entries[id] = { failedRounds: 0 });
    if (!vpnOff) continue;
    if (good(results[id])) {
      e.failedRounds = 0;
      e.offMs = results[id];
      e.offAt = at;
    } else if (!suspect) {
      e.failedRounds = (e.failedRounds || 0) + 1;
    }
  }
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
  return { entries, suspect: vpnOff && ids.length > 0 ? suspect : prev.suspect };
}

// isUnreachable: failed FAILED_ROUNDS_TO_HIDE proxy-off rounds in a row (before the safeguards).
export function isUnreachable(state, id) {
  const e = entryOf(state, id);
  return Boolean(e && (e.failedRounds || 0) >= FAILED_ROUNDS_TO_HIDE);
}

// hiddenIds: Set of ids among `ids` to hide from the list and from the
// automatic choice, after the safeguards; never one of `keep`.
export function hiddenIds(state, ids, keep = []) {
  const hidden = new Set();
  const all = [...new Set((ids || []).filter((id) => id !== undefined && id !== null && id !== "").map(String))];
  const s = sane(state);
  if (s.suspect || all.length === 0) return hidden;
  const unreachable = all.filter((id) => isUnreachable(s, id));
  // Half of the servers or more: the network is the problem, not the servers.
  if (unreachable.length * 2 >= all.length) return hidden;
  const kept = new Set((keep || []).filter((id) => id !== undefined && id !== null && id !== "").map(String));
  for (const id of unreachable) if (!kept.has(id)) hidden.add(id);
  return hidden;
}

// visible: `servers` without the hidden ones, same order.
export function visible(state, servers, keep = []) {
  const list = servers || [];
  const hidden = hiddenIds(state, list.map((s) => s && s.id), keep);
  return hidden.size === 0 ? list.slice() : list.filter((s) => !(s && hidden.has(String(s.id))));
}

// displayPing: the ping a row shows, or null ("— ms").
//   live: the latest { ms, at } measurement of the server (any round) or undefined.
//   connected: the proxy is on. Then a measurement counts only when at most
//   OFF_CACHE_MS old; a server that could not be measured outside the proxy
//   falls back to its last proxy-off ping within OFF_CACHE_MS.
//   Proxy off: the latest measurement counts for maxAgeMs (default 6 h, like auto.js).
export function displayPing(state, id, { live, connected = false, now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  const within = (at, limit) => typeof at === "number" && now - at <= limit && at <= now + 60000;
  if (live && good(live.ms) && within(live.at, connected ? OFF_CACHE_MS : maxAgeMs)) return live.ms;
  const e = entryOf(state, id);
  return connected && e && good(e.offMs) && within(e.offAt, OFF_CACHE_MS) ? e.offMs : null;
}
