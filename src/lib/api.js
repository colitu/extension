// Colitu account API: the same endpoints the apps use, plus the extension's
// own /webproxy/session. Tokens live in extension storage only.

import { API_BASE as BASE, ext, TARGET } from "./target.js";
import { load, save } from "./store.js";

export const API_BASE = BASE;
export const WEB_BASE = "https://colitu.com";
export const APP_BASE = "https://app.colitu.com";

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

async function request(path, { method = "GET", body, token, deviceId, timeout = 20000, headers: extra } = {}) {
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
  const text = await res.text();
  if (text.length > 1 << 20) throw new ApiError(res.status, "RESPONSE_TOO_LARGE");
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
  return data;
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
        const tokens = await request("/auth/refresh", { method: "POST", body: { refresh_token: auth.refresh }, deviceId: auth.deviceId });
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
      return { token: b.mfa_token, expiresIn: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 3600) : 300 };
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

export async function linkPoll(pollToken) {
  const res = await fetch(API_BASE + "/auth/link/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ poll_token: pollToken }),
    credentials: "omit",
    cache: "no-store",
  });
  if (res.status === 202) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data && data.error && data.error.code);
  await save({ auth: tokensToAuth(data, {}) });
  return true;
}

export async function registerDevice() {
  const auth = await getAuth();
  const device = await authorized("/devices/register", {
    method: "POST",
    noDevice: true,
    body: {
      device_key: await deviceKey(),
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
  const me = await authorized("/me").catch(() => null);
  if (me && me.email) await save({ auth: { ...(await getAuth()), email: me.email } });
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
