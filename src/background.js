// Colitu browser extension — background (Chrome service worker, Firefox
// event page). Owns the session, the proxy setting and the toolbar icon; the
// popup only sends commands and renders the state it gets back.

import { ext, TARGET } from "./lib/target.js";
import { load, save, remove, settings as loadSettings, migrateTicket, migrateAuth, applyKeepSignedIn } from "./lib/store.js";
import * as api from "./lib/api.js";
import * as proxy from "./lib/proxy.js";
import { buildRules, parseSplitList, SPLIT_MAX_CHARS, SPLIT_MODES, splitListTooLong, splitSettings } from "./lib/routing.js";
import { languages, resolveLanguage } from "./lib/i18n.js";
import { pausedInfo } from "./lib/plan.js";
import * as notices from "./lib/notices.js";
import { AUTO_RECHECK_MS, chooseAuto, measurementState } from "./lib/auto.js";
import * as events from "./lib/events.js";
import * as survey from "./lib/survey.js";
import * as referral from "./lib/referral.js";
import { displayName } from "./lib/servernames.js";
import { pickSiteServer } from "./lib/site.js";

const REFRESH_ALARM = "colitu-session";
// The server list comes with the ticket, which may be refreshed only every
// couple of hours; a server the panel dropped (shut down, unreachable) must
// leave the list sooner than that: at the next REFRESH_ALARM (30 min).
const SERVER_LIST_MAX_AGE_MS = 25 * 60 * 1000;
const LINK_ALARM = "colitu-link";
const LATENCY_ALARM = "colitu-latency";
// While traffic is held back for a new proxy ticket (holdForTicket), the
// ticket is asked for again after 15 s, 30 s, 1 min, 2 min, then every 5 min.
const TICKET_ALARM = "colitu-ticket";
const TICKET_RETRY_MS = [15e3, 30e3, 60e3, 120e3, 300e3];
const PLAN_ERRORS = new Set(["QUOTA_EXCEEDED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED"]);
// Answers to a 2FA code after which the same challenge can be tried again.
const MFA_RETRY = new Set(["MFA_INVALID_CODE", "RATE_LIMITED", "NETWORK"]);

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
      // Any failure closes the door: Firefox would otherwise connect directly.
      try {
        await ready;
        return proxy.safeDecision(details.url);
      } catch {
        return proxy.unreachable();
      }
    },
    { urls: ["<all_urls>"] },
  );
  ext.proxy.onError.addListener((e) => noteProxyError(e && e.message));
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The website's server map (content script on colitu.com): plain result, no envelope.
  if (message && message.type === "site-connect") {
    siteConnect(message, sender).then(sendResponse, () => sendResponse({ ok: false, reason: "error" }));
    return true;
  }
  handle(message || {}).then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: { code: err.code || "ERROR", message: String(err.message || err) } }),
  );
  return true;
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshIfDue().catch(() => {});
  if (alarm.name === LINK_ALARM) pollLink().catch(() => {});
  if (alarm.name === LATENCY_ALARM) periodic().catch(() => {});
  if (alarm.name === TICKET_ALARM) retryTicket().catch(() => {});
});

// Firefox: the optional data-collection permission can also be switched in
// about:addons; the setting follows it.
if (TARGET === "firefox" && ext.permissions && ext.permissions.onAdded) {
  const follow = (permissions, on) => {
    if (permissions && Array.isArray(permissions.data_collection) && permissions.data_collection.some((d) => events.STATS_DATA_COLLECTION.includes(d))) {
      // On only once every permission of the switch is granted.
      (on ? statsPermitted() : Promise.resolve(false)).then((all) => setStats(all)).catch(() => {});
    }
  };
  ext.permissions.onAdded.addListener((p) => follow(p, true));
  ext.permissions.onRemoved.addListener((p) => follow(p, false));
}

ext.runtime.onStartup.addListener(() => {
  startup().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  ext.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
  ext.alarms.create(LATENCY_ALARM, { periodInMinutes: AUTO_RECHECK_MS / 60000 });
  startup().catch(() => {});
});

const ready = init();

async function init() {
  try {
    // A ticket 1.4.0 kept on disk moves to session memory before anything
    // else reads or writes the session.
    await migrateTicket();
    // Sign-in tokens that older versions kept on disk move to session memory.
    await migrateAuth();
    const { connection, session } = await load(["connection", "session"]);
    if (connection && connection.on && session && session.ticket) {
      proxy.remember(connection.rules, connection.chain, session.ticket);
    } else if (connection && connection.on) {
      // Connected, but the ticket is gone (it lives in session memory: a
      // browser restart or an extension update empties it). Hold traffic
      // back until a new one arrives; startup() fetches it.
      await holdForTicket();
    } else if (connection && connection.blocking) {
      proxy.rememberBlock(apiHosts());
    }
  } catch {
    // Nothing stored that we can read: start disconnected.
  }
  await paintBadge().catch(() => {});
}

// holdForTicket: the proxy needs a ticket this browser no longer has. Until
// refreshSession() brings a new one (and connect() puts the proxy chain
// back), traffic is held back exactly like the kill switch: only local
// addresses and the Colitu API go direct, everything else fails. Nothing
// leaves directly, and the API request that fetches the ticket never goes
// to a proxy that would ask for the ticket it is fetching.
async function holdForTicket() {
  await proxy.block(apiHosts());
  scheduleTicketRetry();
  await paintBadge().catch(() => {});
}

// holding: connected, but traffic is held back until a ticket arrives.
async function holding() {
  const { connection } = await load(["connection"]);
  return Boolean(connection && connection.on && proxy.isBlocking());
}

let ticketRetryStep = 0;
let ticketTimer = null;

// scheduleTicketRetry: the next try for a ticket while traffic is held back,
// backing off to every 5 minutes. A timer for the short steps; an alarm as
// well, since the service worker may be stopped before the timer fires
// (Chrome wakes it for an alarm, at the soonest after 30 s).
function scheduleTicketRetry() {
  const delay = TICKET_RETRY_MS[Math.min(ticketRetryStep, TICKET_RETRY_MS.length - 1)];
  ticketRetryStep++;
  clearTimeout(ticketTimer);
  ticketTimer = setTimeout(() => {
    ticketTimer = null;
    retryTicket().catch(() => {});
  }, delay);
  try {
    ext.alarms.create(TICKET_ALARM, { when: Date.now() + Math.max(delay, 30e3) });
  } catch {
    // alarms unavailable: the timer and the 30-minute refresh remain
  }
}

function stopTicketRetry() {
  ticketRetryStep = 0;
  clearTimeout(ticketTimer);
  ticketTimer = null;
  try {
    const cleared = ext.alarms.clear(TICKET_ALARM);
    if (cleared && cleared.catch) cleared.catch(() => {});
  } catch {
    // nothing scheduled
  }
}

// retryTicket asks for a ticket again while traffic is held back. Success
// puts the proxy chain back (refreshSession -> connect); a failure waits for
// the next step. Turned off or signed out meanwhile: nothing left to do.
async function retryTicket() {
  if (!(await holding())) {
    stopTicketRetry();
    return;
  }
  await refreshSession().catch(() => {});
  if (await holding()) scheduleTicketRetry();
  else stopTicketRetry();
  await paintBadge().catch(() => {});
}

function apiHosts() {
  return [new URL(api.API_BASE).hostname];
}

async function ensureAlarm(name, minutes) {
  try {
    if (!(await ext.alarms.get(name))) ext.alarms.create(name, { periodInMinutes: minutes });
  } catch {
    // alarms unavailable: the next start tries again
  }
}

async function startup() {
  await ready;
  await ensureAlarm(REFRESH_ALARM, 30);
  await ensureAlarm(LATENCY_ALARM, AUTO_RECHECK_MS / 60000);
  // Measure the servers on start (also fills "Automatic") and send queued events.
  periodic().catch(() => {});
  const { connection } = await load(["connection"]);
  const s = await loadSettings();
  if (!connection || !(connection.on || connection.blocking)) return;
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
  const data = await load(["auth", "session", "connection", "status", "link", "pings", "entitlement", "paused", "latency", "lastGood"]);
  const s = await loadSettings();
  const auth = data.auth;
  const mfa = await mfaPending();
  return {
    target: TARGET,
    version: api.version(),
    signedIn: Boolean(auth && auth.refresh && auth.deviceId),
    pendingDevice: Boolean(auth && auth.refresh && !auth.deviceId),
    email: (auth && auth.email) || "",
    company: auth && auth.company && auth.company.name ? { name: String(auth.company.name), role: String(auth.company.role || "member") } : null,
    session: data.session ? { servers: data.session.servers, plan: data.session.plan, expiresAt: data.session.expiresAt } : null,
    connection: data.connection || { on: false, serverId: "auto" },
    // Connected, but traffic is held back until a new proxy ticket arrives.
    holding: Boolean(data.connection && data.connection.on && proxy.isBlocking()),
    status: data.status || {},
    link: data.link && data.link.expiresAt > Date.now() ? { code: data.link.code, url: data.link.url, expiresAt: data.link.expiresAt } : null,
    // The popup learns that a code is wanted, never the challenge token.
    mfa: mfa ? { email: mfa.email, method: mfa.method === "email" ? "email" : "totp", expiresAt: mfa.expiresAt } : null,
    pings: data.pings || {},
    entitlement: data.entitlement || null,
    // Set while the plan's device limit pauses this browser (DEVICE_OVER_LIMIT).
    paused: auth && auth.deviceId && data.paused ? { limit: data.paused.limit, active: data.paused.active || [], deviceId: auth.deviceId } : null,
    settings: s,
    split: (() => {
      const sp = splitSettings(s);
      return { mode: sp.mode, count: sp.count };
    })(),
    // What "Automatic" would pick now (shown under its name).
    auto: autoInfo(data.session, data.latency, data.lastGood),
    // The statistics switch as it really works (Firefox: also needs the permission).
    statsActive: await statsEnabled(),
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
        await setMfa({ token: challenge.token, email, method: challenge.method, expiresAt: Date.now() + challenge.expiresIn * 1000 });
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
      await measureLatency();
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
    case "notices":
      return currentNotice();
    case "notice-dismiss": {
      const ctx = await noticeContext();
      if (!ctx) return null;
      await notices.dismiss({ id: String(msg.id || "").slice(0, 200), report: ctx.report });
      return currentNotice();
    }
    case "notice-click": {
      const ctx = await noticeContext();
      if (ctx) await notices.clicked({ id: String(msg.id || "").slice(0, 200), report: ctx.report });
      return null;
    }
    case "referral":
      return currentReferral();
    case "survey":
      return currentSurvey();
    case "survey-answer": {
      const score = Number(msg.score);
      if (!Number.isInteger(score) || score < 0 || score > 10) throw Object.assign(new Error("bad score"), { code: "ERROR" });
      await survey.answer({ score, platform: TARGET, post: api.surveyAnswer });
      return null;
    }
    case "survey-dismiss":
      await survey.dismiss({ platform: TARGET, post: api.surveyAnswer });
      return null;
    default:
      throw Object.assign(new Error("unknown command"), { code: "UNKNOWN_COMMAND" });
  }
}

// --- invite card and survey ---------------------------------------------------

// The invite card for the popup (or null: off, old panel, offline). Cached for
// 10 minutes so reopening the popup does not ask again.
async function currentReferral() {
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) return null;
  const { referralCache: cache } = await load(["referralCache"]);
  if (cache && cache.deviceId === auth.deviceId && cache.at <= Date.now() && Date.now() - cache.at < referral.CACHE_MS) return cache.card;
  let card = null;
  try {
    card = referral.parseReferral(await api.referral());
  } catch {
    card = null;
  }
  await save({ referralCache: { at: Date.now(), deviceId: auth.deviceId, card } });
  return card;
}

// "nps" when the survey row should show (checked with the API at most daily).
async function currentSurvey() {
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) return null;
  return survey.pending({ fetchSurvey: api.surveyDue });
}

// --- notices -----------------------------------------------------------------

async function noticeContext() {
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) return null;
  const s = await loadSettings();
  return { deviceId: auth.deviceId, lang: resolveLanguage(s.language), fetchList: api.notices, report: api.noticeEvent };
}

// The banner for the popup: at most one request per 15 minutes, and none at
// all while signed out.
async function currentNotice() {
  const ctx = await noticeContext();
  return ctx ? notices.current(ctx) : null;
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
  const link = { code: start.code, url: start.url, pollToken: start.poll_token, expiresAt: Date.now() + (start.expires_in || 600) * 1000, interval: api.linkInterval(start.interval) };
  if (!api.isColituUrl(link.url)) throw Object.assign(new Error("unexpected link URL"), { code: "ERROR" });
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
        await new Promise((r) => setTimeout(r, api.linkInterval(link.interval) * 1000));
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
  if (!session || !session.ticket || Date.now() >= session.refreshAt) return refreshSession();
  const { paused } = await load(["paused"]);
  if (!paused && !sessionInFlight && !(Date.now() - (session.fetchedAt || 0) < SERVER_LIST_MAX_AGE_MS)) await refreshSession({ reapply: false });
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
        servers: api.sanitizeServers(s.servers),
        plan: s.plan || null,
        fetchedAt: Date.now(),
      };
      await save({ session });
      if (entitlement && typeof entitlement === "object") await save({ entitlement });
      // Account e-mail + optional company seat; never blocks the refresh.
      await api.refreshAccount().catch(() => {});
      await remove(["paused"]);
      proxy.setTicket(session.ticket);
      await setStatus({ error: null });
      // "Automatic" needs latencies; keep them fresh (the proxy hosts are
      // always reached directly, see measureLatency).
      const { pingsAt } = await load(["pingsAt"]);
      if (!pingsAt || Date.now() - pingsAt > AUTO_RECHECK_MS) measureLatency().catch(() => {});
      const { connection } = await load(["connection"]);
      // Back from a drop: the kill switch lets go as soon as Colitu is on again.
      if (reapply && connection && (connection.on || connection.blocking)) await connect(connection.serverId, { keepSession: true });
      return session;
    } catch (err) {
      const { connection: before } = await load(["connection"]);
      const wasOn = Boolean(before && before.on);
      if (api.isTerminal(err) || err.code === "SIGNED_OUT") {
        await localSignOut("SESSION_EXPIRED", { block: true });
        if (wasOn) await announceProtectionOff();
      } else if (err.code === "DEVICE_OVER_LIMIT") {
        await pause(err);
        if (wasOn) await announceProtectionOff();
      } else if (PLAN_ERRORS.has(err.code)) {
        await disconnect({ block: true });
        if (wasOn) await announceProtectionOff();
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

// siteConnect: "Connect to this server" on colitu.com. Only the content script
// of the two colitu.com origins may ask. The answer carries no secrets.
const SITE_ORIGINS = ["https://colitu.com", "https://www.colitu.com"];

async function siteConnect(msg, sender) {
  let origin = "";
  try {
    origin = new URL(sender && sender.url).origin;
  } catch {
    origin = "";
  }
  if (!sender || !sender.tab || !SITE_ORIGINS.includes(origin)) return { ok: false, reason: "forbidden" };
  const country = String(msg.country ?? "");
  const city = String(msg.city ?? "").slice(0, 64);
  if (!/^[a-z]{2}$/i.test(country)) return { ok: false, reason: "error", country, city };
  await ready;
  const { auth, session } = await load(["auth", "session"]);
  if (!(auth && auth.refresh && auth.deviceId) || !session || !Array.isArray(session.servers) || !session.servers.length) {
    return { ok: false, reason: "signed-out", country, city };
  }
  const server = pickSiteServer(session.servers, country, city);
  if (!server) return { ok: false, reason: "unavailable", country, city };
  let code = "";
  try {
    await connect(server.id);
  } catch (err) {
    code = String((err && err.code) || "ERROR");
  }
  const { connection, status } = await load(["connection", "status"]);
  const on = Boolean(connection && connection.on);
  if (code === "SIGNED_OUT") return { ok: false, reason: "signed-out", country, city };
  let reason = "";
  if (!on) reason = String(code || (status && status.error) || "error").toLowerCase().replace(/_/g, "-");
  const lang = resolveLanguage((await loadSettings().catch(() => ({}))).language);
  const cur = on && connection.current ? connection.current : server;
  return { ok: on, reason, country, city: String(cur.city ?? server.city ?? ""), name: displayName(cur.name ?? server.name, lang, cur.country ?? server.country) };
}

// pickChain: the servers to use, first one preferred. A chosen server is the
// only entry; "auto" asks chooseAuto (lowest fresh latency, Russia excluded,
// failed ones skipped) and keeps the next best as failover.
function pickChain(servers, serverId, latency, lastGood) {
  if (!servers.length) return { chain: [], pick: null };
  if (serverId && serverId !== "auto") {
    const s = servers.find((x) => x.id === serverId);
    return { chain: s ? [s] : [], pick: null };
  }
  const pick = chooseAuto(servers, latency, { lastGood });
  return { chain: pick ? pick.chain : [], pick };
}

// autoInfo: what "Automatic" would pick now, for the popup (no secrets).
function autoInfo(session, latency, lastGood) {
  const pick = session && session.servers && session.servers.length ? chooseAuto(session.servers, latency, { lastGood }) : null;
  if (!pick) return null;
  const s = pick.server;
  return { id: String(s.id), name: String(s.name ?? ""), country: String(s.country ?? ""), city: String(s.city ?? ""), ms: pick.ms };
}

async function connect(serverId, { keepSession = false } = {}) {
  const started = performance.now();
  await ready;
  if (await proxy.controlledByOther()) throw Object.assign(new Error("proxy controlled by another extension"), { code: "PROXY_CONTROLLED" });
  let { session, paused } = await load(["session", "paused"]);
  // A paused browser asks the API again: it may have been activated elsewhere.
  if (paused && keepSession) throw Object.assign(new Error("device paused"), { code: "DEVICE_OVER_LIMIT" });
  if (!keepSession && (paused || !session || !session.ticket || session.expiresAt - Date.now() < 30 * 60 * 1000)) {
    session = await refreshSession({ reapply: false });
  }
  if (!session || !session.ticket) throw Object.assign(new Error("no session"), { code: "SIGNED_OUT" });
  const auto = !serverId || serverId === "auto";
  let { latency, lastGood } = await load(["latency", "lastGood"]);
  latency = latency || {};
  // First "Automatic" connect with nothing measured yet: measure now, but do
  // not make the user wait more than 3 s (results that arrive in time count).
  if (auto && !keepSession && !session.servers.some((x) => measurementState(latency[x.id], Date.now()) === "ok")) {
    await Promise.race([measureLatency().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    latency = { ...latency, ...liveLatency };
  }
  const { chain, pick } = pickChain(session.servers, serverId, latency, lastGood);
  if (!chain.length) {
    if (serverId !== "auto" && session.servers.length) return connect("auto", { keepSession });
    throw Object.assign(new Error("no servers"), { code: "NO_SERVERS" });
  }
  const s = await loadSettings();
  const rules = buildRules(s, session.servers, chain[0].country, [new URL(api.API_BASE).hostname]);
  const hops = chain.map((x) => ({ host: x.host, port: x.port }));
  try {
    await proxy.apply(rules, hops, session.ticket);
  } catch (err) {
    track({ kind: "connect", node_id: chain[0].id, outcome: "fail", reason: "other", ms: performance.now() - started, first_try: true, mode: auto ? "auto" : "manual" });
    throw err;
  }
  await proxy.setWebRTC(s.webrtc);
  const { connection: previous } = await load(["connection"]);
  const sameServer = previous && previous.on && previous.chain && previous.chain[0] && previous.chain[0].host === hops[0].host;
  await save({
    connection: {
      on: true,
      serverId: serverId || "auto",
      current: { id: String(chain[0].id), name: String(chain[0].name ?? ""), country: String(chain[0].country ?? ""), city: String(chain[0].city ?? "") },
      chain: hops,
      rules,
      since: sameServer ? previous.since : Date.now(),
    },
  });
  await setStatus({ error: null, proxyError: null });
  await paintBadge();
  if (!sameServer) {
    // Automatic picked a server (not a re-apply of the same one): tell how it
    // compares with the fastest measured server.
    if (auto && pick && pick.ms !== null && pick.best) {
      track({ kind: "choice", node_id: pick.server.id, ms: pick.ms, best_node_id: pick.best.id, best_ms: pick.bestMs, mode: "auto" });
    }
    verifyConnection({ node: chain[0].id, auto, started }).catch(() => {});
  }
}

// verifyConnection is the first proxied request after turning on (the same
// check the popup shows as "exit IP"). It decides the "connect" event: ok when
// the answer came through Colitu, fail otherwise. ms = turning on -> answer.
async function verifyConnection({ node, auto, started }) {
  const { lastConnectFail } = await load(["lastConnectFail"]);
  const firstTry = !(typeof lastConnectFail === "number" && Date.now() - lastConnectFail < 120000);
  const result = await checkExit();
  const ms = performance.now() - started;
  const { connection } = await load(["connection"]);
  // Turned off or moved to another server meanwhile: nothing to report.
  if (!connection || !connection.on || !connection.current || String(connection.current.id) !== String(node)) return;
  if (result.ok) {
    await remove(["lastConnectFail"]);
    if (auto) await save({ lastGood: String(node) });
    track({ kind: "connect", node_id: node, outcome: "ok", ms, first_try: firstTry, mode: auto ? "auto" : "manual" });
    return;
  }
  await save({ lastConnectFail: Date.now() });
  const { status } = await load(["status"]);
  const pe = status && status.proxyError;
  // The proxy's own error (if one just happened) explains it best; else the
  // failed request; else the API answered around the proxy.
  const reason = pe && Date.now() - pe.at < 30000 ? events.mapReason(pe.error) : result.error ? events.mapReason(result.error) : "other";
  track({ kind: "connect", node_id: node, outcome: "fail", reason, ms, first_try: firstTry, mode: auto ? "auto" : "manual" });
}

// disconnect turns the proxy off. With block (the connection dropped by
// itself, not by the user) and the kill switch on, it installs the blocking
// proxy instead: nothing leaves around Colitu until the connection is back
// (connect) or the user lets traffic out (a plain disconnect).
async function disconnect({ block = false } = {}) {
  if (block) {
    const s = await loadSettings();
    const { connection: before } = await load(["connection"]);
    if (s.killSwitch && before && (before.on || before.blocking)) {
      await proxy.block(apiHosts());
      await save({ connection: { on: false, blocking: true, serverId: before.serverId || "auto" } });
      await setStatus({ exit: null, proxyError: null });
      await paintBadge();
      return;
    }
  }
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
  await disconnect({ block: true });
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

// announceProtectionOff: the proxy was removed without the user asking (plan
// ended, session expired, device paused), so pages now load without Colitu.
// The badge alone was easy to miss; open the status page in a tab once.
async function announceProtectionOff() {
  try {
    await ext.tabs.create({ url: ext.runtime.getURL("popup/popup.html") });
  } catch {
    // A missing window (browser closing) must not break the error path.
  }
}

async function localSignOut(reason, { block = false } = {}) {
  await disconnect({ block });
  await clearMfa();
  await remove(["auth", "session", "link", "pings", "pingsAt", "latency", "lastGood", "entitlement", "paused", "survey", "referralCache", "networkToken", "lastConnectFail", "dropFor"]);
  await events.clear();
  await setStatus({ error: reason || null, exit: null });
}

async function signOut() {
  await disconnect();
  await api.signOut();
  await localSignOut(null);
}

// Setting values are checked by type; anything else is ignored.
const BOOLEAN_SETTINGS = ["webrtc", "ruDirect", "autoConnect", "killSwitch", "stats", "keepSignedIn"];

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current };
  for (const key of BOOLEAN_SETTINGS) if (key in patch) next[key] = Boolean(patch[key]);
  if ("language" in patch) next.language = patch.language === "auto" || languages.includes(patch.language) ? patch.language : "auto";
  if ("split" in patch) next.split = SPLIT_MODES.includes(patch.split) ? patch.split : "off";
  if ("splitList" in patch && typeof patch.splitList === "string") next.splitList = patch.splitList;
  next.split = SPLIT_MODES.includes(next.split) ? next.split : "off";
  if (typeof next.splitList !== "string") next.splitList = "";
  // Stored as the cleaned list. Invalid entries are dropped (the popup refuses
  // to save them in the first place), but a list that does not fit is refused
  // as a whole: cutting it would send the cut sites around the proxy.
  if (next.splitList.length > 1 << 20) throw Object.assign(new Error("split list too long"), { code: "SPLIT_TOO_LONG" });
  const parsed = parseSplitList(next.splitList);
  if (splitListTooLong(parsed)) throw Object.assign(new Error("split list too long"), { code: "SPLIT_TOO_LONG" });
  next.splitList = parsed.entries.join("\n");
  await save({ settings: next });
  // Turning the statistics off clears everything queued.
  if (!next.stats) await events.clear();
  // The refresh token goes to disk or off it right away.
  if ("keepSignedIn" in patch) await applyKeepSignedIn();
  // Only the statistics or stay-signed-in switch changed: the connection stays as it is.
  if (Object.keys(patch).every((k) => k === "stats" || k === "keepSignedIn")) return;
  const { connection } = await load(["connection"]);
  if (connection && connection.blocking && !next.killSwitch) {
    // Turning the kill switch off lets traffic out again.
    await disconnect();
  } else if (connection && connection.on) {
    await connect(connection.serverId, { keepSession: true });
  }
}

// The API host goes through the proxy (with a direct fallback), so the
// address it sees tells whether traffic really leaves through Colitu.
async function checkExit() {
  try {
    const who = await api.whoami();
    await setStatus({ exit: { ip: who.ip, country: who.country, colitu: Boolean(who.colitu), at: Date.now() } });
    return { ok: Boolean(who.colitu) };
  } catch (err) {
    await setStatus({ exit: null });
    return { ok: false, error: err };
  }
}

// --- latency (for "Automatic") -------------------------------------------------
//
// Method: for every server the session lists, a timed HEAD request to
// https://<host>:<port>/ - the same address the proxy connection uses. The
// request is no-cors (any HTTP answer, even the proxy's 407, completes it; only
// a failed connection or TLS handshake rejects) and never follows redirects.
// A first request pays the TCP + TLS handshake and is not counted; the two
// that follow reuse the connection, so each is about one round trip, and the
// smaller one is kept. 4 s per request; a server that answers none is
// recorded as failed.
//
// This never goes through the proxy: the proxy hosts are always DIRECT in the
// extension's own routing rules (routing.js route()), also while connected. If
// a host is not in the active rules (a server that appeared after the last
// connect) or the kill switch is holding traffic back, that server is not
// measured now and its earlier measurement (valid for 6 h) is reused.

let measuring = null;
// Results of the run in progress, so a connect that cannot wait still uses them.
let liveLatency = {};

async function timedHead(url, timeout = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    await fetch(url, { method: "HEAD", mode: "no-cors", redirect: "manual", cache: "no-store", credentials: "omit", signal: controller.signal });
    return performance.now() - started;
  } finally {
    clearTimeout(timer);
  }
}

async function pingServer(s) {
  const url = `https://${s.host}:${s.port}/`;
  try {
    await timedHead(url); // handshake, not counted
  } catch (err) {
    return { ms: null, error: err };
  }
  const times = [];
  let lastError = null;
  for (let i = 0; i < 2; i++) {
    try {
      times.push(await timedHead(url));
    } catch (err) {
      lastError = err;
    }
  }
  return times.length ? { ms: Math.max(1, Math.round(Math.min(...times))) } : { ms: null, error: lastError };
}

function measureLatency() {
  if (measuring) return measuring;
  measuring = (async () => {
    try {
      await ready;
      const { session, latency: old } = await load(["session", "latency"]);
      if (!session || !session.servers || !session.servers.length) return;
      // Kill switch engaged: server hosts are blocked like everything else.
      if (proxy.isBlocking()) return;
      const active = proxy.current();
      const direct = active ? new Set(active.rules.servers || []) : null; // null: proxy off, everything is direct
      const targets = session.servers.slice(0, 40).filter((s) => !direct || direct.has(s.host));
      const enabled = await statsEnabled();
      const next = {};
      for (const s of session.servers) if (old && old[s.id]) next[s.id] = old[s.id];
      liveLatency = {};
      await Promise.all(
        targets.map(async (s) => {
          const r = await pingServer(s);
          const record = { ms: r.ms, at: Date.now() };
          next[s.id] = record;
          liveLatency[s.id] = record;
          const reason = r.ms === null ? (r.error && r.error.name === "AbortError" ? "timeout" : events.mapReason(r.error)) : undefined;
          await events.record({ kind: "probe", node_id: s.id, outcome: r.ms === null ? "fail" : "ok", reason, ms: r.ms }, enabled);
        }),
      );
      const pings = {};
      for (const [id, rec] of Object.entries(next)) if (measurementState(rec, Date.now()) !== "unknown") pings[id] = rec.ms;
      await save({ latency: next, pings, pingsAt: Date.now() });
      await recheckAuto();
    } finally {
      measuring = null;
    }
  })();
  return measuring;
}

// recheckAuto: "Automatic" is on and its server just failed to answer while
// another one does: connect again, which picks the best one.
async function recheckAuto() {
  const { connection, session, latency, lastGood } = await load(["connection", "session", "latency", "lastGood"]);
  if (!connection || !connection.on || connection.serverId !== "auto" || !connection.current || !session || !session.ticket) return;
  if (measurementState((latency || {})[connection.current.id], Date.now()) !== "failed") return;
  const pick = chooseAuto(session.servers, latency, { lastGood });
  if (pick && pick.ms !== null && pick.server.id !== connection.current.id) await connect("auto", { keepSession: true });
}

// Every 30 minutes (alarm) and at start: measure, then send queued events.
async function periodic() {
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) return;
  await ready;
  await measureLatency().catch(() => {});
  await flushEvents().catch(() => {});
}

// --- usage statistics ------------------------------------------------------------

// statsEnabled: the switch is on and, in Firefox, the optional data-collection
// permission is granted (the user can also withdraw it in about:addons).
async function statsEnabled() {
  const s = await loadSettings();
  if (!s.stats) return false;
  if (TARGET !== "firefox") return true;
  return statsPermitted();
}

// statsPermitted (Firefox): every data-collection permission of the switch.
async function statsPermitted() {
  try {
    return Boolean(await ext.permissions.contains({ data_collection: events.STATS_DATA_COLLECTION }));
  } catch {
    return true; // Firefox before 140 has no data-collection permissions: the switch is the consent
  }
}

async function setStats(on) {
  const s = await loadSettings();
  if (s.stats === on) return;
  await save({ settings: { ...s, stats: on } });
  if (!on) await events.clear();
}

async function track(event) {
  try {
    await events.record(event, await statsEnabled());
  } catch {
    // statistics must never break a connection
  }
}

// The network token (country + ISP key) comes with GET /servers, not with the
// session. Read at most once a day, only when a report is about to go out.
async function networkToken() {
  const { networkToken: kept } = await load(["networkToken"]);
  const age = kept && typeof kept.at === "number" ? Date.now() - kept.at : Infinity;
  if (age < 24 * 3600 * 1000) return kept.token || "";
  if (!proxy.isBlocking()) {
    try {
      const token = await api.networkToken();
      await save({ networkToken: { token, at: Date.now() } });
      return token;
    } catch {
      // keep going with the old one (if still valid) or none
    }
  }
  return kept && age < events.NETWORK_TOKEN_MAX_AGE_MS ? kept.token || "" : "";
}

async function flushEvents() {
  const enabled = await statsEnabled();
  if (!enabled) return events.clear();
  const auth = await api.getAuth();
  if (!auth || !auth.deviceId) return;
  await events.flush({ enabled, post: api.acEvents, platform: TARGET, appVersion: api.version(), networkToken });
}

// A proxy that stops working while on: only proxy-level errors count, and only
// after a check through the proxy fails. One "drop" per connection.
let dropChecking = false;
async function maybeDrop(error) {
  if (dropChecking || !events.isProxyFailure(error)) return;
  dropChecking = true;
  try {
    const { connection, dropFor } = await load(["connection", "dropFor"]);
    if (!connection || !connection.on || !connection.current || dropFor === connection.since) return;
    if (Date.now() - connection.since < 20000) return; // still connecting: the connect event covers it
    const result = await checkExit();
    if (result.ok) return;
    await save({ dropFor: connection.since });
    await track({ kind: "drop", node_id: connection.current.id, reason: events.mapReason(error), minutes: Math.round((Date.now() - connection.since) / 60000) });
  } finally {
    dropChecking = false;
  }
}

// --- proxy authentication and errors (Chrome) --------------------------------

const authAttempts = new Map();

async function proxyCredentials(details) {
  let { session, connection } = await load(["session", "connection"]);
  if (!session || !connection || !connection.on) return {};
  const host = details.challenger && details.challenger.host;
  if (!(connection.chain || []).some((p) => p.host === host)) return {};
  if (!session.ticket) {
    // The ticket lives in memory only (store.js) and is gone. Never wait for
    // it here: the request asking may be the very API call that fetches it.
    // Hold traffic back (the API then goes direct), fetch a new ticket in
    // the background; connect() puts the proxy chain back when it arrives.
    await holdForTicket().catch(() => {});
    if (!sessionInFlight) refreshSession().catch(() => {});
    return { cancel: true };
  }
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
  maybeDrop(error).catch(() => {});
}

// --- toolbar icon --------------------------------------------------------------

async function paintBadge() {
  const { connection } = await load(["connection"]);
  const on = Boolean(connection && connection.on);
  const blocking = Boolean(connection && connection.blocking);
  // Connected, but held back until a ticket arrives: "connecting", not a
  // country (nothing goes out yet).
  const held = on && proxy.isBlocking();
  const sizes = [16, 32, 48, 128];
  const path = Object.fromEntries(sizes.map((s) => [s, `icons/${on ? "on" : "off"}-${s}.png`]));
  await ext.action.setIcon({ path }).catch(() => {});
  const cc = on && connection.current && connection.current.country ? String(connection.current.country).toUpperCase() : "";
  // The kill switch holds traffic back: a red "!" instead of a country.
  const text = blocking ? "!" : held ? "…" : cc;
  await ext.action.setBadgeText({ text });
  if (text) {
    await ext.action.setBadgeBackgroundColor({ color: blocking ? "#d93a3a" : held ? "#d9902b" : "#7c6cff" });
    if (ext.action.setBadgeTextColor) await ext.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
  }
  // The toolbar tooltip names the server in the extension language.
  let serverName = "";
  if (on && connection.current) {
    const lang = resolveLanguage((await loadSettings().catch(() => ({}))).language);
    serverName = displayName(connection.current.name, lang, connection.current.country);
  }
  const title = held
    ? "Colitu VPN — connecting, traffic held back"
    : on
      ? `Colitu VPN — ${serverName}`
      : blocking
        ? "Colitu VPN — traffic blocked"
        : "Colitu VPN";
  await ext.action.setTitle({ title });
}
