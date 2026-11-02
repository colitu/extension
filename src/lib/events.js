// Connection events (POST /client/ac-events), sent only while the user has
// "Usage statistics" on. The queue lives in extension
// storage (newest 500), a report goes out at most once an hour with up to 300
// events. Events carry no account, device, IP or site: only the server id
// (node id), the protocol ("webproxy"), an outcome, a reason and a time; the
// report adds the signed network token (country + provider). The request is
// signed in like every API call (the token only keeps strangers from
// writing); the server adds the events to day totals and keeps nothing that
// links them to the account or device.

import { load, save, remove } from "./store.js";

// Firefox data-collection permissions behind the "Usage statistics" switch:
// technical data and the network's country and provider (the signed network
// token). Optional; the switch asks for both and works only with both.
export const STATS_DATA_COLLECTION = ["technicalAndInteraction", "locationInfo"];

export const QUEUE_CAP = 500;
export const BATCH_MAX = 300;
export const MIN_INTERVAL_MS = 3600 * 1000;
export const PROTOCOL = "webproxy";
export const NETWORK_TOKEN_MAX_AGE_MS = 47 * 3600 * 1000; // the API signs it for 48 h

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REASONS = ["timeout", "reset", "tls", "dns", "refused", "auth", "blocked", "other"];

// mapReason turns a browser proxy error into one of the API's reasons.
//   Chrome (proxy.onProxyError, net error names) | Firefox (proxy.onError message)
//   timeout : ERR_CONNECTION_TIMED_OUT, ERR_TIMED_OUT | NS_ERROR_NET_TIMEOUT, "timed out"
//   reset   : ERR_CONNECTION_RESET/CLOSED/ABORTED, ERR_EMPTY_RESPONSE | NS_ERROR_NET_RESET, NS_ERROR_NET_INTERRUPT
//   tls     : ERR_PROXY_CERTIFICATE_INVALID, ERR_SSL_*, ERR_CERT_* | SEC_ERROR_*, SSL_ERROR_*, "certificate"
//   dns     : ERR_NAME_NOT_RESOLVED, ERR_NAME_RESOLUTION_FAILED | NS_ERROR_UNKNOWN_(PROXY_)HOST
//   refused : ERR_PROXY_CONNECTION_FAILED, ERR_CONNECTION_REFUSED | NS_ERROR_(PROXY_)CONNECTION_REFUSED
//   auth    : ERR_PROXY_AUTH_*, HTTP 407 | NS_ERROR_PROXY_AUTHENTICATION_FAILED
//   blocked : ERR_BLOCKED_*, ERR_ACCESS_DENIED, HTTP 403 | NS_ERROR_PROXY_FORBIDDEN, "403"
//   other   : everything else (including a plain "no network")
// API errors from the extension's own request ({code:"NETWORK", message:"timeout"})
// map the same way through their message.
export function mapReason(error) {
  const e = String(error && typeof error === "object" ? (error.message || error.code || "") : error || "");
  if (/TIMED_OUT|NET_TIMEOUT|timed? ?out|^timeout$/i.test(e)) return "timeout";
  if (/PROXY_AUTH|AUTHENTICATION_FAILED|\b407\b/i.test(e)) return "auth";
  if (/CERT|SSL|SEC_ERROR|certificate|handshake|\btls\b/i.test(e)) return "tls";
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION|UNKNOWN_(PROXY_)?HOST|\bdns\b/i.test(e)) return "dns";
  if (/CONNECTION_REFUSED|PROXY_CONNECTION_FAILED|refus/i.test(e)) return "refused";
  if (/CONNECTION_(RESET|CLOSED|ABORTED)|EMPTY_RESPONSE|NET_RESET|NET_INTERRUPT|\breset\b/i.test(e)) return "reset";
  if (/BLOCKED|ACCESS_DENIED|PROXY_FORBIDDEN|\b403\b|blocked/i.test(e)) return "blocked";
  return "other";
}

// isProxyFailure: true for errors of the proxy itself. A single site that does
// not answer also raises proxy errors (ERR_TUNNEL_CONNECTION_FAILED) and is not
// the proxy failing.
export function isProxyFailure(error) {
  const e = String(error && typeof error === "object" ? error.message || "" : error || "");
  return /proxy/i.test(e) && !/TUNNEL/i.test(e);
}

const int = (v, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
};

// sanitize: an event in the API's shape, or null when it cannot be sent
// (unknown kind, node id that is not a lower-case UUID).
export function sanitize(event) {
  if (!event || typeof event !== "object") return null;
  // AC4 whitelist mode entered or left: no node, stored per country + provider only.
  if (event.kind === "whitelist") {
    const total = (v) => {
      const n = int(v, 10);
      return n !== null && n >= 1 ? n : null;
    };
    const fo = int(event.foreign_ok, 10);
    const ft = total(event.foreign_total);
    const dok = int(event.domestic_ok, 10);
    const dt = total(event.domestic_total);
    if ((event.state !== "on" && event.state !== "off") || fo === null || ft === null || dok === null || dt === null || fo > ft || dok > dt) return null;
    const out = { kind: "whitelist", state: event.state, foreign_ok: fo, foreign_total: ft, domestic_ok: dok, domestic_total: dt };
    const ms = int(event.ms, 600000);
    if (ms !== null) out.ms = ms;
    return out;
  }
  const node = String(event.node_id || "").toLowerCase();
  if (!UUID.test(node)) return null;
  const out = { kind: event.kind, node_id: node, protocol: PROTOCOL };
  const reason = REASONS.includes(event.reason) ? event.reason : "other";
  const outcome = event.outcome === "ok" ? "ok" : "fail";
  switch (event.kind) {
    case "connect": {
      out.outcome = outcome;
      if (outcome === "fail") out.reason = reason;
      const ms = int(event.ms, 600000);
      if (ms !== null) out.ms = ms;
      out.first_try = Boolean(event.first_try);
      out.mode = event.mode === "auto" ? "auto" : "manual";
      return out;
    }
    case "drop": {
      out.reason = reason;
      out.minutes = int(event.minutes, 100000) ?? 0;
      return out;
    }
    case "probe": {
      out.outcome = outcome;
      if (outcome === "fail") out.reason = reason;
      const ms = int(event.ms, 600000);
      if (ms !== null && outcome === "ok") out.ms = ms;
      return out;
    }
    case "choice": {
      delete out.protocol;
      const best = String(event.best_node_id || "").toLowerCase();
      const ms = int(event.ms, 600000);
      const bestMs = int(event.best_ms, 600000);
      if (!UUID.test(best) || ms === null || bestMs === null) return null;
      return { kind: "choice", node_id: node, ms, best_node_id: best, best_ms: bestMs, mode: "auto" };
    }
    default:
      return null;
  }
}

// addToQueue: appends the event (newest last) and drops the oldest beyond the
// cap. A probe replaces the earlier queued probe of the same node, so only the
// last one per node stays.
export function addToQueue(queue, event, cap = QUEUE_CAP) {
  const clean = sanitize(event);
  if (!clean) return queue;
  const base = clean.kind === "probe" ? queue.filter((e) => !(e.kind === "probe" && e.node_id === clean.node_id)) : queue.slice();
  base.push(clean);
  return base.length > cap ? base.slice(base.length - cap) : base;
}

export function buildPayload({ platform, appVersion, networkToken, events }) {
  return {
    platform,
    app_version: appVersion,
    network_token: networkToken || "",
    network_type: "",
    events: events.slice(0, BATCH_MAX),
  };
}

// --- storage and sending -----------------------------------------------------

// One operation at a time: a flush and a new event must not overwrite each other.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readQueue() {
  const { acQueue } = await load(["acQueue"]);
  return Array.isArray(acQueue) ? acQueue.filter((e) => e && typeof e === "object") : [];
}

// record queues an event when `enabled`; otherwise nothing is kept.
export function record(event, enabled) {
  if (!enabled) return Promise.resolve();
  return serial(async () => {
    await save({ acQueue: addToQueue(await readQueue(), event) });
  });
}

export function clear() {
  return serial(async () => {
    await remove(["acQueue", "acSentAt"]);
  });
}

export function queued() {
  return serial(readQueue);
}

// flush sends one report when it is due. `post(payload)` resolves with
// { status } (202 accepted) or throws an error with .status (0 = network).
//   202                 -> the sent events leave the queue
//   400                 -> the events are dropped (they would never be accepted)
//   429, 5xx, network   -> kept for the next try
// With `enabled` false the queue is simply cleared.
export function flush({ enabled, post, platform, appVersion, networkToken, now = Date.now() }) {
  return serial(async () => {
    if (!enabled) {
      await remove(["acQueue", "acSentAt"]);
      return "disabled";
    }
    const { acSentAt } = await load(["acSentAt"]);
    if (typeof acSentAt === "number" && acSentAt <= now && now - acSentAt < MIN_INTERVAL_MS) return "wait";
    const queue = await readQueue();
    if (!queue.length) return "empty";
    const batch = queue.slice(0, BATCH_MAX);
    const token = typeof networkToken === "function" ? await networkToken() : networkToken;
    try {
      await post(buildPayload({ platform, appVersion, networkToken: token, events: batch }));
    } catch (err) {
      if (err && err.status === 400) {
        await save({ acQueue: (await readQueue()).slice(batch.length), acSentAt: now });
        return "dropped";
      }
      return "kept";
    }
    await save({ acQueue: (await readQueue()).slice(batch.length), acSentAt: now });
    return "sent";
  });
}
