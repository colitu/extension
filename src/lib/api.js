// Colitu account API: the same endpoints the apps use, plus the extension's
// own /webproxy/session. Tokens live in extension storage only.

import { API_BASE as BASE, ext, TARGET } from "./target.js";
import { load, save } from "./store.js";

export const API_BASE = BASE;
export const WEB_BASE = "https://colitu.com";
export const APP_BASE = "https://app.colitu.com";

// registerUrl: the "create account" page. src tells the signup source:
// extension:chrome or extension:firefox.
export function registerUrl(target = TARGET) {
  return `${APP_BASE}/register?src=extension:${target === "firefox" ? "firefox" : "chrome"}`;
}

// isColituUrl: links the API hands out (device link, account pages) are only
// opened when they are https on colitu.com, so a compromised or spoofed API
// answer cannot open an arbitrary page in a new tab.
export function isColituUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "colitu.com" || url.hostname.endsWith(".colitu.com"));
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  constructor(status, code, message, body = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || (status ? `HTTP_${status}` : "NETWORK");
    // The parsed error body, for answers that carry more than a code
    // (MFA_REQUIRED brings the mfa_token). Never sent to the popup.
    this.body = body;
  }
}

// Tells the API this client can answer a two-step verification challenge.
// Without it, accounts with 2FA get MFA_REQUIRED_UPDATE_APP.
const FEATURES = { "X-Colitu-Features": "mfa" };

// Answers that mean the session is over and cannot come back.
const TERMINAL = new Set(["AUTH_REFRESH_REUSED", "AUTH_INVALID_CREDENTIALS", "DEVICE_REVOKED", "DEVICE_NOT_FOUND", "DEVICE_TOKEN_MISMATCH"]);

export function version() {
  return ext.runtime.getManifest().version;
}

const MAX_BODY = 1 << 20;

// readBody reads the answer as a stream and stops at MAX_BODY bytes, so an
// oversized answer is never held in memory whole.
async function readBody(res) {
  const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (declared > MAX_BODY) {
    if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
    throw new ApiError(res.status, "RESPONSE_TOO_LARGE");
  }
  if (!res.body || !res.body.getReader) {
    const text = await res.text();
    if (text.length > MAX_BODY) throw new ApiError(res.status, "RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new ApiError(res.status, "RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// request calls the API. With withStatus the answer is { status, data } (for
// endpoints where 202 and 200 mean different things).
async function request(path, { method = "GET", body, token, deviceId, timeout = 20000, headers: extra, withStatus = false } = {}) {
  const headers = { Accept: "application/json", ...(extra || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (deviceId) headers["X-Device-ID"] = deviceId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    throw new ApiError(0, "NETWORK", err && err.name === "AbortError" ? "timeout" : String(err && err.message));
  } finally {
    clearTimeout(timer);
  }
  const text = await readBody(res);
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiError(res.status, e && e.code, e && e.message, data);
  }
  return withStatus ? { status: res.status, data } : data;
}

function decodeExp(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
    return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function tokensToAuth(tokens, previous = {}) {
  if (!tokens || !tokens.access_token) throw new ApiError(502, "INVALID_TOKENS");
  return {
    ...previous,
    access: tokens.access_token,
    refresh: tokens.refresh_token || previous.refresh,
    accessExp: decodeExp(tokens.access_token) || Date.now() + (tokens.expires_in || 600) * 1000,
  };
}

// --- device identity -------------------------------------------------------

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "ext-" + TARGET + "-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deviceKey() {
  let { deviceKey: key } = await load(["deviceKey"]);
  if (!key) {
    key = randomKey();
    await save({ deviceKey: key });
  }
  return key;
}

export function browserName() {
  const ua = navigator.userAgent || "";
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const has = (name) => brands.some((b) => b.brand === name);
  if (TARGET === "firefox") return "Firefox";
  if (/YaBrowser\//.test(ua)) return "Yandex Browser";
  if (has("Microsoft Edge") || /Edg\//.test(ua)) return "Edge";
  if (has("Opera") || /OPR\//.test(ua)) return "Opera";
  if (has("Brave") || navigator.brave) return "Brave";
  if (has("Vivaldi") || /Vivaldi\//.test(ua)) return "Vivaldi";
  return "Chrome";
}

export function osName() {
  const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();
  if (p.includes("win") || ua.includes("windows")) return "Windows";
  if (p.includes("mac") || ua.includes("mac os")) return "macOS";
  if (p.includes("cros") || ua.includes("cros")) return "ChromeOS";
  if (p.includes("android") || ua.includes("android")) return "Android";
  if (p.includes("linux") || ua.includes("linux")) return "Linux";
  return "";
}

// --- session -------------------------------------------------------------

let refreshing = null;

export async function getAuth() {
  const { auth } = await load(["auth"]);
  return auth || null;
}

async function refreshTokens(auth) {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        // Another request may have refreshed already while this one waited
        // for its 401: the stored session is newer than the caller's copy.
        // Sending the old refresh token again would be a reuse, which the
        // API answers with a terminal error.
        const latest = await getAuth();
        if (!latest || !latest.refresh) throw new ApiError(401, "SIGNED_OUT");
        if (latest.refresh !== auth.refresh) return latest;
        let tokens;
        try {
          tokens = await request("/auth/refresh", { method: "POST", body: { refresh_token: auth.refresh }, deviceId: auth.deviceId });
        } catch (err) {
          // A concurrent refresh in another context may have won in the
          // meantime: the stored token changed, the session is still alive.
          if (err instanceof ApiError && err.code === "AUTH_REFRESH_REUSED") {
            const newer = await getAuth();
            if (newer && newer.refresh && newer.refresh !== auth.refresh) return newer;
          }
          throw err;
        }
        const current = await getAuth();
        // Signed out while the refresh was running: do not bring it back.
        if (!current || current.refresh !== auth.refresh) throw new ApiError(401, "SIGNED_OUT");
        const next = tokensToAuth(tokens, current);
        await save({ auth: next });
        return next;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

// authorized calls an endpoint as the signed-in device, refreshing the access
// token first when it is about to expire and once more on a 401.
export async function authorized(path, options = {}) {
  let auth = await getAuth();
  if (!auth || !auth.refresh) throw new ApiError(401, "SIGNED_OUT");
  if (!auth.access || Date.now() > auth.accessExp - 60000) auth = await refreshTokens(auth);
  const deviceId = options.noDevice ? undefined : auth.deviceId;
  try {
    return await request(path, { ...options, token: auth.access, deviceId });
  } catch (err) {
    if (err.status !== 401) throw err;
    auth = await refreshTokens(auth);
    return request(path, { ...options, token: auth.access, deviceId });
  }
}

export function isTerminal(err) {
  return err instanceof ApiError && TERMINAL.has(err.code);
}

// login signs in with e-mail and password. It returns null when the session
// is stored, or { token, expiresIn } when the account has two-step
// verification on: the caller then asks for a code and calls loginMfa. The
// challenge token is handed back to the caller and never stored here.
export async function login(email, password) {
  let tokens;
  try {
    tokens = await request("/auth/login", { method: "POST", body: { email, password }, headers: FEATURES });
  } catch (err) {
    const b = err instanceof ApiError && err.code === "MFA_REQUIRED" ? err.body : null;
    if (b && typeof b.mfa_token === "string" && b.mfa_token) {
      const ttl = Number(b.mfa_expires_in);
      // mfa_method: "email" = a 6-digit sign-in code mailed because of an
      // unfamiliar country (no 2FA on the account); missing/other = "totp".
      const method = b.mfa_method === "email" ? "email" : "totp";
      return { token: b.mfa_token, method, expiresIn: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 3600) : 300 };
    }
    throw err;
  }
  await save({ auth: tokensToAuth(tokens, { email }) });
  return null;
}

// loginMfa finishes a sign-in that needed a second factor: a 6-digit code from
// the authenticator app or a recovery code. The answer is the same as a
// successful /auth/login.
export async function loginMfa(mfaToken, code, email) {
  const tokens = await request("/auth/login/mfa", { method: "POST", body: { mfa_token: mfaToken, code }, headers: FEATURES });
  await save({ auth: tokensToAuth(tokens, { email }) });
}

// Device link: the extension shows a code, the user approves it on
// app.colitu.com (already signed in there), the extension collects tokens.
export async function linkStart() {
  return request("/auth/link/start", { method: "POST", body: { device_name: `${browserName()} · ${osName()}`.slice(0, 100), platform: TARGET } });
}

// linkInterval keeps the poll interval the API suggests in a sane range
// (seconds): a huge value would stall the sign-in loop.
export function linkInterval(value) {
  const n = Number(value);
  return Math.min(60, Math.max(2, Number.isFinite(n) && n > 0 ? n : 3));
}

export async function linkPoll(pollToken) {
  const { status, data } = await request("/auth/link/poll", { method: "POST", body: { poll_token: pollToken }, timeout: 15000, withStatus: true });
  if (status === 202) return null;
  await save({ auth: tokensToAuth(data, {}) });
  return true;
}

// isPublicV4 is false for addresses that are not on the open internet:
// this network, private (RFC 1918), loopback, CGNAT, link-local, the IETF
// and documentation ranges, benchmarking, multicast and reserved (the same
// list as the iOS app's latency probe).
function isPublicV4([a, b, c]) {
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113));
}

// isLocalHost is true for a server host that does not lead to the open
// internet: localhost, a single-label (intranet) name, a local-only suffix,
// or an IPv4 address in a non-public range, also when written in a short,
// octal or hex form ("127.1", "0x7f.0.0.1"), which the browser reads as an
// address. A spoofed or compromised API answer could otherwise make the
// extension probe the user's local network and hand the proxy ticket to a
// local listener.
export function isLocalHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return true;
  if (/(^|\.)(localhost|local|lan|home|internal|intranet|localdomain|home\.arpa)$/.test(h)) return true;
  let canonical;
  try {
    canonical = new URL(`https://${h}/`).hostname;
  } catch {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(canonical);
  if (m) return !isPublicV4(m.slice(1).map(Number));
  // An all-numeric host that is not a valid address: never a server.
  return /^[0-9.]+$/.test(h);
}

// sanitizeServers keeps the servers the API lists that are safe to use: the
// host goes into the PAC chain and a URL, so it may only be a plain host name
// or address on the open internet, and the port must be a real port. Texts
// are made strings.
export function sanitizeServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 200)) {
    if (!s || typeof s !== "object") continue;
    const host = typeof s.host === "string" ? s.host.trim().toLowerCase() : "";
    const port = typeof s.port === "number" ? s.port : NaN;
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) continue;
    if (isLocalHost(host)) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (s.id === undefined || s.id === null || s.id === "") continue;
    out.push({
      ...s,
      id: String(s.id).slice(0, 80),
      name: String(s.name ?? "").slice(0, 120),
      country: String(s.country ?? "").slice(0, 8),
      city: String(s.city ?? "").slice(0, 80),
      host,
      port,
      load: s.load === "medium" || s.load === "high" ? s.load : "low",
      // AC4: the panel marks servers it recommends; first inside their country.
      recommended: s.recommended === true,
      // AC4 phase 3: the entry address works under mobile operators' whitelists.
      // Default off when the panel does not send it to the extension.
      whitelist_ok: s.whitelist_ok === true,
      categories: Array.isArray(s.categories) ? s.categories.slice(0, 8).map((c) => String(c).slice(0, 40)) : undefined,
    });
  }
  return out;
}

export async function registerDevice() {
  const auth = await getAuth();
  const key = await deviceKey();
  const device = await authorized("/devices/register", {
    method: "POST",
    noDevice: true,
    body: {
      device_key: key,
      // The random installation key outlives sign-out, so it also serves as
      // the installation fingerprint: one free account per installation.
      hardware_id: key,
      name: `${browserName()} · ${osName() || "Browser"}`.slice(0, 100),
      platform: TARGET,
      app_version: version(),
      os_version: osName(),
      capabilities: { config_formats: ["sing-box"], protocols: [] },
    },
  });
  if (!device || !device.id) throw new ApiError(502, "DEVICE_REGISTRATION_INVALID");
  const current = await getAuth();
  if (!current || current.refresh !== auth.refresh) throw new ApiError(401, "SIGNED_OUT");
  // Bind the refresh token to this device: from now on every access token
  // carries the device id.
  const bound = await refreshTokens({ ...current, deviceId: device.id });
  await save({ auth: { ...bound, deviceId: device.id, appVersion: version() } });
  await refreshAccount();
}

// refreshAccount re-reads /me: the e-mail and the optional company seat
// (absent = no company, which clears the stored one). A failed request keeps
// the last known values.
export async function refreshAccount() {
  const me = await authorized("/me").catch(() => null);
  if (!me || typeof me !== "object" || !me.email) return;
  const c = me.company;
  const company = c && typeof c.name === "string" && c.name ? { name: c.name, role: String(c.role || "member") } : undefined;
  const current = await getAuth();
  if (!current || !current.refresh) return;
  await save({ auth: { ...current, email: me.email, company } });
}

export async function sendVerification(locale) {
  await authorized("/auth/email/send", { method: "POST", noDevice: true, body: { locale } });
}

export async function verifyEmail(code) {
  await authorized("/auth/email/verify", { method: "POST", noDevice: true, body: { code } });
}

export async function webSession() {
  return authorized("/webproxy/session", { method: "POST" });
}

// entitlement: plan details beyond the session's plan (device count, when a
// trial ends and what comes next).
export async function entitlement() {
  return authorized("/me/entitlement", { timeout: 10000 });
}

// notices: the in-app banners for this account (usage warnings, campaigns).
// An older panel answers 404; the caller treats every failure as "none".
export async function notices(lang) {
  return authorized(`/client/notices?lang=${encodeURIComponent(lang)}`, { timeout: 10000 });
}

// noticeEvent reports "seen", "clicked" or "dismissed" for a notice id (the id
// contains ":" and is URL-encoded). The answer is 204.
export async function noticeEvent(id, event) {
  await authorized(`/client/notices/${encodeURIComponent(id)}/events`, { method: "POST", body: { event }, timeout: 10000 });
}

// referral: the account's invite card (link, rules, results).
export async function referral() {
  return authorized("/referral", { timeout: 10000 });
}

// surveyDue: { survey: { kind } | null }. surveyAnswer posts an answer or a
// dismissal (see survey.js for the bodies).
export async function surveyDue() {
  return authorized("/client/survey", { timeout: 10000 });
}

export async function surveyAnswer(body) {
  await authorized("/client/survey", { method: "POST", body, timeout: 10000 });
}

// acEvents: one connection-events report (events.js). 202 = accepted.
export async function acEvents(payload) {
  await authorized("/client/ac-events", { method: "POST", body: payload, timeout: 15000 });
}

// networkToken: the signed, opaque network key (country + ISP) that the
// servers list carries while the request does not come through a Colitu node.
// The extension's own session answer does not include it, so it is read from
// GET /servers. Returns "" when the API gives none.
export async function networkToken() {
  const data = await authorized("/servers", { timeout: 10000 });
  const token = data && typeof data.network_token === "string" ? data.network_token : "";
  return token.length <= 256 ? token : "";
}

// serversMeta: the parts of GET /servers that Adaptive Connect 4 needs: the rollout
// switch (features.ac_engine_4), the network's country and key (client_country,
// client_network; empty when unknown), the whitelist control hosts, the servers the
// panel hints as blocked on this network, and the signed network token. Fields the
// panel does not send come back null / empty.
export async function serversMeta() {
  const data = await authorized("/servers", { timeout: 10000 });
  const d = data && typeof data === "object" ? data : {};
  const hints = d.network_hints && typeof d.network_hints === "object" ? d.network_hints : null;
  return {
    features: d.features && typeof d.features === "object" ? d.features : null,
    country: typeof d.client_country === "string" ? d.client_country : "",
    network: typeof d.client_network === "string" ? d.client_network.slice(0, 64) : "",
    probe: d.whitelist_probe,
    hinted: hints && Array.isArray(hints.blocked_servers) ? hints.blocked_servers.filter((x) => typeof x === "string").slice(0, 200) : null,
    token: typeof d.network_token === "string" && d.network_token.length <= 256 ? d.network_token : "",
  };
}

// acModel: the Adaptive Connect 4 decision model (GET /client/ac-model, same auth as
// the other client calls). Through the proxy the panel takes the country (and city)
// from the signed network token (at most 256 characters) of the last /servers fetched
// with the VPN off; pass it while the proxy is on.
export async function acModel(networkToken) {
  const path = networkToken ? `/client/ac-model?network_token=${encodeURIComponent(networkToken)}` : "/client/ac-model";
  return authorized(path, { timeout: 15000 });
}

// activateDevice makes this browser the active device when the plan's device
// limit paused it (DEVICE_OVER_LIMIT); another device is paused instead.
export async function activateDevice(deviceId) {
  return authorized(`/devices/${encodeURIComponent(deviceId)}/activate`, { method: "POST", body: {} });
}

// signOut frees the device slot (the extension is a device like an app) and
// revokes the refresh token. Failures are ignored: local data goes anyway.
export async function signOut() {
  const auth = await getAuth();
  if (auth && auth.deviceId) {
    await authorized(`/devices/${encodeURIComponent(auth.deviceId)}`, { method: "DELETE" }).catch(() => {});
  }
  if (auth && auth.refresh) {
    await request("/auth/logout", { method: "POST", body: { refresh_token: auth.refresh } }).catch(() => {});
  }
}

export async function whoami() {
  return request("/public/whoami", { timeout: 10000 });
}
