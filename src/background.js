// Colitu browser extension — background (Chrome service worker, Firefox
// event page). Owns the session, the proxy setting and the toolbar icon; the
// popup only sends commands and renders the state it gets back.

import { ext, TARGET } from "./lib/target.js";
import { load, save, remove, settings as loadSettings } from "./lib/store.js";
import * as api from "./lib/api.js";
import * as proxy from "./lib/proxy.js";
import { buildRules, parseSplitList, SPLIT_MODES, splitSettings } from "./lib/routing.js";
import { resolveLanguage } from "./lib/i18n.js";
import { pausedInfo } from "./lib/plan.js";

const REFRESH_ALARM = "colitu-session";
const LINK_ALARM = "colitu-link";
const PLAN_ERRORS = new Set(["QUOTA_EXCEEDED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED"]);
// Answers to a 2FA code after which the same challenge can be tried again.
const MFA_RETRY = new Set(["MFA_INVALID_CODE", "RATE_LIMITED", "NETWORK"]);
const LOAD_RANK = { low: 0, medium: 1, high: 2 };

// --- listeners that must exist at the top level (MV3 wakes us for them) ---

if (TARGET === "chrome") {
  ext.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) {
        callback({});
        return;
      }
      proxyCredentials(details).then(callback, () => callback({}));
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"],
  );
  ext.proxy.onProxyError.addListener((e) => noteProxyError(e && e.error));
} else {
  ext.proxy.onRequest.addListener(
    async (details) => {
      await ready;
      return proxy.firefoxDecision(details.url);
    },
    { urls: ["<all_urls>"] },
  );
  ext.proxy.onError.addListener((e) => noteProxyError(e && e.message));
}

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message || {}).then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: { code: err.code || "ERROR", message: String(err.message || err) } }),
  );
  return true;
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshIfDue().catch(() => {});
  if (alarm.name === LINK_ALARM) pollLink().catch(() => {});
});

ext.runtime.onStartup.addListener(() => {
  startup().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  ext.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
  startup().catch(() => {});
});

const ready = init();

async function init() {
  const { connection, session } = await load(["connection", "session"]);
  if (connection && connection.on && session) {
    proxy.remember(connection.rules, connection.chain, session.ticket);
  }
  await paintBadge();
}

async function startup() {
  await ready;
  const { connection } = await load(["connection"]);
  const s = await loadSettings();
  if (!connection || !connection.on) return;
  if (!s.autoConnect) {
    await disconnect();
    return;
  }
  // The proxy setting survives a restart, but the ticket may not.
  await refreshSession().catch(() => {});
  const fresh = await load(["connection"]);
  if (fresh.connection && fresh.connection.on) await connect(fresh.connection.serverId).catch(() => {});
}

// --- state for the popup -------------------------------------------------

async function state() {
  await ready;
  const data = await load(["auth", "session", "connection", "status", "link", "pings", "entitlement", "paused"]);
  const s = await loadSettings();
  const auth = data.auth;
  const mfa = await mfaPending();
  return {
    target: TARGET,
    version: api.version(),
    signedIn: Boolean(auth && auth.refresh && auth.deviceId),
    pendingDevice: Boolean(auth && auth.refresh && !auth.deviceId),
    email: (auth && auth.email) || "",
    session: data.session ? { servers: data.session.servers, plan: data.session.plan, expiresAt: data.session.expiresAt } : null,
    connection: data.connection || { on: false, serverId: "auto" },
    status: data.status || {},
    link: data.link && data.link.expiresAt > Date.now() ? { code: data.link.code, url: data.link.url, expiresAt: data.link.expiresAt } : null,
    // The popup learns that a code is wanted, never the challenge token.
    mfa: mfa ? { email: mfa.email, expiresAt: mfa.expiresAt } : null,
    pings: data.pings || {},
    entitlement: data.entitlement || null,
    // Set while the plan's device limit pauses this browser (DEVICE_OVER_LIMIT).
    paused: auth && auth.deviceId && data.paused ? { limit: data.paused.limit, active: data.paused.active || [], deviceId: auth.deviceId } : null,
    settings: s,
    split: (() => {
      const sp = splitSettings(s);
      return { mode: sp.mode, count: sp.count };
    })(),
    blocked: await proxy.controlledByOther(),
    incognito: TARGET === "chrome" ? await ext.extension.isAllowedIncognitoAccess() : null,
  };
}

async function setStatus(patch) {
  const { status } = await load(["status"]);
  await save({ status: { ...(status || {}), ...patch } });
}

// --- commands --------------------------------------------------------------

async function handle(msg) {
  switch (msg.cmd) {
    case "state":
      return state();
    case "login": {
      const email = String(msg.email || "").trim();
      await clearMfa();
      const challenge = await api.login(email, String(msg.password || ""));
      if (challenge) {
        await setMfa({ token: challenge.token, email, expiresAt: Date.now() + challenge.expiresIn * 1000 });
        await setStatus({ error: null });
        return state();
      }
      await finishSignIn();
      return state();
    }
    case "login-mfa":
      await loginMfa(String(msg.code || "").trim());
      return state();
    case "mfa-cancel":
      await clearMfa();
      return state();
    case "link-start":
      await clearMfa();
      return startLink();
    case "link-cancel":
      await remove(["link"]);
      ext.alarms.clear(LINK_ALARM);
      return state();
    case "finish-sign-in":
      await finishSignIn();
      return state();
    case "verify-send":
      await api.sendVerification(msg.locale || "en");
      return state();
    case "verify-code":
      await api.verifyEmail(String(msg.code || "").trim());
      await finishSignIn();
      return state();
    case "sign-out":
      await signOut();
      return state();
    case "connect":
      await connect(msg.serverId || "auto");
      return state();
    case "disconnect":
      await disconnect();
      return state();
    case "refresh":
      await refreshSession();
      return state();
    case "ping":
      await measurePings();
      return state();
    case "settings":
      await saveSettings(msg.settings || {});
      return state();
    case "check-exit":
      await checkExit();
      return state();
    case "activate-device":
      await activateDevice();
      return state();
    default:
      throw Object.assign(new Error("unknown command"), { code: "UNKNOWN_COMMAND" });
  }
}

async function finishSignIn() {
  try {
    await api.registerDevice();
  } catch (err) {
    await setStatus({ error: err.code || "ERROR" });
    // Same as the apps: an unverified account gets a code right away.
    if (err.code === "EMAIL_NOT_VERIFIED") {
      const s = await loadSettings();
      await api.sendVerification(resolveLanguage(s.language)).catch(() => {});
    }
    throw err;
  }
  await setStatus({ error: null });
  await refreshSession();
  ext.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
}

// --- two-step verification ---------------------------------------------------
//
// The challenge token from /auth/login lives in this worker's memory and in
// storage.session (memory only, gone when the browser closes; it outlives a
// suspended service worker and a closed popup, so the user can fetch the code
// from another app). It is never written to storage.local.

let mfaMemory = null;
const sessionArea = ext.storage && ext.storage.session;

async function setMfa(value) {
  mfaMemory = value;
  if (sessionArea) await sessionArea.set({ mfa: value }).catch(() => {});
}

async function clearMfa() {
  mfaMemory = null;
  if (sessionArea) await sessionArea.remove("mfa").catch(() => {});
}

async function mfaPending() {
  let value = mfaMemory;
  if (!value && sessionArea) value = ((await sessionArea.get("mfa").catch(() => ({}))) || {}).mfa || null;
  if (value && !(value.expiresAt > Date.now() && value.token)) {
    await clearMfa();
    value = null;
  }
  mfaMemory = value;
  return value;
}

async function loginMfa(code) {
  const pending = await mfaPending();
  if (!pending) throw Object.assign(new Error("two-step sign-in expired"), { code: "MFA_TOKEN_EXPIRED" });
  if (!code || code.length > 64) throw Object.assign(new Error("no code"), { code: "MFA_INVALID_CODE" });
  try {
    await api.loginMfa(pending.token, code, pending.email);
  } catch (err) {
    // A wrong code, a rate limit or a network failure keep the challenge;
    // anything else (expired, used, unknown) means starting over.
    if (!MFA_RETRY.has(err.code) && !(err.status >= 500)) await clearMfa();
    throw err;
  }
  await clearMfa();
  await finishSignIn();
}

// --- device link (sign in with colitu.com) ----------------------------------

let linkLoop = null;

async function startLink() {
  const start = await api.linkStart();
  const link = { code: start.code, url: start.url, pollToken: start.poll_token, expiresAt: Date.now() + (start.expires_in || 600) * 1000, interval: Math.max(2, start.interval || 3) };
  await save({ link });
  ext.tabs.create({ url: link.url });
  // The popup closes when the tab opens, so polling happens here. The alarm
  // restarts the loop if the browser suspends the service worker.
  ext.alarms.create(LINK_ALARM, { periodInMinutes: 0.5 });
  pollLink().catch(() => {});
  return state();
}

async function pollLink() {
  if (linkLoop) return linkLoop;
  linkLoop = (async () => {
    try {
      for (;;) {
        const { link } = await load(["link"]);
        if (!link) break;
        if (link.expiresAt < Date.now()) {
          await remove(["link"]);
          await setStatus({ error: "LINK_EXPIRED" });
          break;
        }
        try {
          if (await api.linkPoll(link.pollToken)) {
            await remove(["link"]);
            try {
              await finishSignIn();
            } catch (err) {
              await setStatus({ error: err.code || "ERROR" });
            }
            break;
          }
        } catch (err) {
          if (err.code === "NETWORK") {
            // keep trying until the code expires
          } else {
            await remove(["link"]);
            await setStatus({ error: err.code || "ERROR" });
            break;
          }
        }
        await new Promise((r) => setTimeout(r, link.interval * 1000));
      }
    } finally {
      linkLoop = null;
      const { link } = await load(["link"]);
      if (!link) ext.alarms.clear(LINK_ALARM);
    }
  })();
  return linkLoop;
}

// --- session and connection ---------------------------------------------------

async function refreshIfDue() {
  const { session, auth } = await load(["session", "auth"]);
  if (!auth || !auth.deviceId) return;
  if (!session || Date.now() >= session.refreshAt) await refreshSession();
}

let sessionInFlight = null;

async function refreshSession({ reapply = true } = {}) {
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = (async () => {
    try {
      const s = await api.webSession();
      // Plan details for the "plan ends soon" notice. Optional: only a paused
      // device stops the refresh, anything else keeps the last answer.
      let entitlement = null;
      try {
        entitlement = await api.entitlement();
      } catch (err) {
        if (err.code === "DEVICE_OVER_LIMIT") throw err;
      }
      const session = {
        ticket: s.ticket,
        expiresAt: Date.parse(s.expires_at),
        refreshAt: Date.now() + Math.max(60, s.refresh_after || 3600) * 1000,
        servers: s.servers || [],
        plan: s.plan || null,
        fetchedAt: Date.now(),
      };
      await save({ session });
      if (entitlement && typeof entitlement === "object") await save({ entitlement });
      await remove(["paused"]);
      proxy.setTicket(session.ticket);
      await setStatus({ error: null });
      // "Fastest server" needs pings; measure them now and then in the
      // background (the proxy hosts are always reached directly).
      const { pingsAt } = await load(["pingsAt"]);
      if (!pingsAt || Date.now() - pingsAt > 6 * 3600 * 1000) measurePings().catch(() => {});
      const { connection } = await load(["connection"]);
      if (reapply && connection && connection.on) await connect(connection.serverId, { keepSession: true });
      return session;
    } catch (err) {
      if (api.isTerminal(err) || err.code === "SIGNED_OUT") {
        await localSignOut("SESSION_EXPIRED");
      } else if (err.code === "DEVICE_OVER_LIMIT") {
        await pause(err);
      } else if (PLAN_ERRORS.has(err.code)) {
        await disconnect();
        const { session } = await load(["session"]);
        if (session) await save({ session: { ...session, ticket: "", plan: null } });
        await setStatus({ error: err.code });
      } else {
        await setStatus({ error: err.code || "ERROR" });
      }
      throw err;
    } finally {
      sessionInFlight = null;
    }
  })();
  return sessionInFlight;
}

function pickChain(servers, serverId, pings) {
  if (!servers.length) return [];
  if (serverId && serverId !== "auto") {
    const s = servers.find((x) => x.id === serverId);
    return s ? [s] : [];
  }
  const score = (s) => {
    const p = pings[s.id];
    return (typeof p === "number" ? p : 400) + LOAD_RANK[s.load || "low"] * 60;
  };
  return [...servers].sort((a, b) => score(a) - score(b)).slice(0, 3);
}

async function connect(serverId, { keepSession = false } = {}) {
  await ready;
  if (await proxy.controlledByOther()) throw Object.assign(new Error("proxy controlled by another extension"), { code: "PROXY_CONTROLLED" });
  let { session, pings, paused } = await load(["session", "pings", "paused"]);
  // A paused browser asks the API again: it may have been activated elsewhere.
  if (paused && keepSession) throw Object.assign(new Error("device paused"), { code: "DEVICE_OVER_LIMIT" });
  if (!keepSession && (paused || !session || !session.ticket || session.expiresAt - Date.now() < 30 * 60 * 1000)) {
    session = await refreshSession({ reapply: false });
  }
  if (!session || !session.ticket) throw Object.assign(new Error("no session"), { code: "SIGNED_OUT" });
  const chain = pickChain(session.servers, serverId, pings || {});
  if (!chain.length) {
    if (serverId !== "auto" && session.servers.length) return connect("auto", { keepSession });
    throw Object.assign(new Error("no servers"), { code: "NO_SERVERS" });
  }
  const s = await loadSettings();
  const rules = buildRules(s, session.servers, chain[0].country, [new URL(api.API_BASE).hostname]);
  const hops = chain.map((x) => ({ host: x.host, port: x.port }));
  await proxy.apply(rules, hops, session.ticket);
  await proxy.setWebRTC(s.webrtc);
  const { connection: previous } = await load(["connection"]);
  const sameServer = previous && previous.on && previous.chain && previous.chain[0] && previous.chain[0].host === hops[0].host;
  await save({
    connection: {
      on: true,
      serverId: serverId || "auto",
      current: { id: chain[0].id, name: chain[0].name, country: chain[0].country, city: chain[0].city },
      chain: hops,
      rules,
      since: sameServer ? previous.since : Date.now(),
    },
  });
  await setStatus({ error: null, proxyError: null });
  await paintBadge();
  if (!sameServer) checkExit().catch(() => {});
}

async function disconnect() {
  await proxy.clear();
  await proxy.setWebRTC(false);
  const { connection } = await load(["connection"]);
  await save({ connection: { on: false, serverId: (connection && connection.serverId) || "auto" } });
  await setStatus({ exit: null, proxyError: null });
  await paintBadge();
}

// pause: the plan's device limit stopped this browser (DEVICE_OVER_LIMIT).
// The proxy goes off and the ticket is dropped, so nothing leaves through
// Colitu or around it by surprise; the popup offers to move the slot here.
async function pause(err) {
  const { connection, paused: before } = await load(["connection", "paused"]);
  const wasOn = Boolean((connection && connection.on) || (before && before.wasOn));
  await disconnect();
  const { session } = await load(["session"]);
  if (session) await save({ session: { ...session, ticket: "" } });
  proxy.setTicket("");
  await save({ paused: { ...pausedInfo(err.body), wasOn, at: Date.now() } });
  await setStatus({ error: "DEVICE_OVER_LIMIT" });
}

// activateDevice: "Use this browser instead". Then the session is fetched
// again, and the connection comes back if the pause had turned it off.
async function activateDevice() {
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) throw Object.assign(new Error("signed out"), { code: "SIGNED_OUT" });
  try {
    await api.activateDevice(auth.deviceId);
  } catch (err) {
    if (err.code === "DEVICE_OVER_LIMIT") await pause(err);
    throw err;
  }
  const { paused, connection } = await load(["paused", "connection"]);
  // refreshSession clears the pause when the API agrees, or sets it again.
  await refreshSession({ reapply: false });
  if (paused && paused.wasOn) await connect((connection && connection.serverId) || "auto");
}

async function localSignOut(reason) {
  await disconnect();
  await clearMfa();
  await remove(["auth", "session", "link", "pings", "pingsAt", "entitlement", "paused"]);
  await setStatus({ error: reason || null, exit: null });
}

async function signOut() {
  await disconnect();
  await api.signOut();
  await localSignOut(null);
}

async function saveSettings(patch) {
  const allowed = ["webrtc", "ruDirect", "autoConnect", "split", "splitList", "language"];
  const current = await loadSettings();
  const next = { ...current };
  for (const key of allowed) if (key in patch) next[key] = patch[key];
  next.split = SPLIT_MODES.includes(next.split) ? next.split : "off";
  // Stored as the cleaned list; invalid entries are dropped (the popup
  // refuses to save them in the first place).
  next.splitList = parseSplitList(String(next.splitList || "").slice(0, 20000)).entries.join("\n");
  await save({ settings: next });
  const { connection } = await load(["connection"]);
  if (connection && connection.on) await connect(connection.serverId, { keepSession: true });
}

// The API host goes through the proxy (with a direct fallback), so the
// address it sees tells whether traffic really leaves through Colitu.
async function checkExit() {
  try {
    const who = await api.whoami();
    await setStatus({ exit: { ip: who.ip, country: who.country, colitu: Boolean(who.colitu), at: Date.now() } });
  } catch {
    await setStatus({ exit: null });
  }
}

async function measurePings() {
  const { session } = await load(["session"]);
  if (!session) return;
  const one = async (s) => {
    const url = `https://${s.host}:${s.port}/`;
    const timed = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const started = performance.now();
      try {
        await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit", signal: controller.signal });
        return performance.now() - started;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await timed(); // TLS handshake
      return [s.id, Math.round(await timed())];
    } catch {
      return [s.id, null];
    }
  };
  const results = await Promise.all(session.servers.slice(0, 40).map(one));
  await save({ pings: Object.fromEntries(results), pingsAt: Date.now() });
}

// --- proxy authentication and errors (Chrome) --------------------------------

const authAttempts = new Map();

async function proxyCredentials(details) {
  const { session, connection } = await load(["session", "connection"]);
  if (!session || !session.ticket || !connection || !connection.on) return {};
  const host = details.challenger && details.challenger.host;
  if (!(connection.chain || []).some((p) => p.host === host)) return {};
  const tries = (authAttempts.get(details.requestId) || 0) + 1;
  authAttempts.set(details.requestId, tries);
  if (authAttempts.size > 500) authAttempts.clear();
  if (tries > 2) {
    // The proxy keeps refusing this ticket: get a new one for the next try.
    refreshSession().catch(() => {});
    return { cancel: true };
  }
  return { authCredentials: { username: "colitu", password: session.ticket } };
}

async function noteProxyError(error) {
  if (!error) return;
  const { connection } = await load(["connection"]);
  if (!connection || !connection.on) return;
  await setStatus({ proxyError: { error: String(error).slice(0, 120), at: Date.now() } });
}

// --- toolbar icon --------------------------------------------------------------

async function paintBadge() {
  const { connection } = await load(["connection"]);
  const on = Boolean(connection && connection.on);
  const sizes = [16, 32, 48, 128];
  const path = Object.fromEntries(sizes.map((s) => [s, `icons/${on ? "on" : "off"}-${s}.png`]));
  await ext.action.setIcon({ path }).catch(() => {});
  const cc = on && connection.current && connection.current.country ? connection.current.country.toUpperCase() : "";
  await ext.action.setBadgeText({ text: cc });
  if (cc) {
    await ext.action.setBadgeBackgroundColor({ color: "#7c6cff" });
    if (ext.action.setBadgeTextColor) await ext.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
  }
  await ext.action.setTitle({ title: on ? `Colitu VPN — ${connection.current ? connection.current.name : ""}` : "Colitu VPN" });
}
