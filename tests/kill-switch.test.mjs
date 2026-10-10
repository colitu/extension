// The background with a fake browser and API: the kill switch ("Block traffic
// if the connection drops"), plus the split-list and settings checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const local = {};
const area = (o) => ({
  get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in o).map((x) => [x, structuredClone(o[x])])),
  set: async (v) => Object.assign(o, structuredClone(v)),
  remove: async (k) => [].concat(k).forEach((x) => delete o[x]),
});
const ev = () => ({ addListener() {} });
let onMessage;
let proxyValue = null; // what the browser's proxy setting holds: null = no proxy
let tabsOpened = 0;
let badge = "";
globalThis.chrome = {
  storage: { local: area(local), session: area({}) },
  runtime: { getManifest: () => ({ version: "1.3.0" }), getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener: (f) => (onMessage = f) }, onStartup: ev(), onInstalled: ev() },
  webRequest: { onAuthRequired: ev() },
  proxy: {
    onProxyError: ev(),
    settings: {
      get: async () => ({ levelOfControl: "controllable_by_this_extension" }),
      set: async ({ value }) => (proxyValue = value),
      clear: async () => (proxyValue = null),
    },
  },
  alarms: { onAlarm: ev(), create() {}, clear() {} },
  action: { setIcon: async () => {}, setBadgeText: async ({ text }) => (badge = text), setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  extension: { isAllowedIncognitoAccess: async () => false },
  privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } },
  i18n: { getUILanguage: () => "en" },
  tabs: { create: () => tabsOpened++ },
};

const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.y`;
const servers = [{ id: "fi", name: "Helsinki", country: "fi", city: "Helsinki", host: "fi.example.test", port: 2083, load: "low" }];
const over = { error: { code: "DEVICE_OVER_LIMIT", message: "device paused" }, device_limit: 1, active_devices: [] };
const failure = (status, code, extra = {}) => new Response(JSON.stringify({ error: { code, message: code }, ...extra }), { status });

// The fake API: each endpoint answers from a variable the tests change.
const api = {
  session: () => new Response(JSON.stringify({ ticket: "v1.t.s", expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), refresh_after: 3600, servers, plan: { status: "trialing", traffic_limit_bytes: null } }), { status: 200 }),
  entitlement: () => new Response(JSON.stringify({ status: "trialing" }), { status: 200 }),
  refresh: () => failure(401, "AUTH_REFRESH_REUSED"),
  activate: () => new Response(JSON.stringify({ id: "dev1", status: "active" }), { status: 200 }),
};
globalThis.fetch = async (url) => {
  if (!String(url).startsWith("https://api.colitu.com/")) throw new Error("offline"); // pings
  const path = String(url).replace("https://api.colitu.com/api/v1", "");
  if (path === "/webproxy/session") return api.session();
  if (path === "/me/entitlement") return api.entitlement();
  if (path === "/auth/refresh") return api.refresh();
  if (path.endsWith("/activate")) return api.activate();
  if (path === "/public/whoami") return new Response(JSON.stringify({ ip: "203.0.113.5", country: "FI", colitu: true }), { status: 200 });
  return new Response("{}", { status: 200 });
};

function signIn() {
  local.auth = { access: jwt, refresh: "r", accessExp: Date.now() + 600e3, deviceId: "dev1", email: "a@b.test" };
}
signIn();
await import("../src/background.js");
const send = (msg) => new Promise((res) => onMessage(msg, {}, res));
const settle = () => new Promise((r) => setTimeout(r, 30));

// Runs the PAC script the browser holds against a host.
function pac(host) {
  assert.equal(proxyValue && proxyValue.mode, "pac_script", "a PAC script is installed");
  const ctx = vm.createContext({});
  vm.runInContext(proxyValue.pacScript.data, ctx);
  return vm.runInContext(`FindProxyForURL("https://x/", ${JSON.stringify(host)})`, ctx);
}
const isBlockingPac = () => proxyValue && proxyValue.pacScript.data.includes("127.0.0.1:9") && !proxyValue.pacScript.data.includes("fi.example.test");

async function connected(killSwitch) {
  signIn();
  api.session = api.session.original || api.session;
  await send({ cmd: "settings", settings: { killSwitch } });
  const r = await send({ cmd: "connect", serverId: "auto" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await settle();
  assert.equal(pac("example.com"), "HTTPS fi.example.test:2083");
  return r.value;
}
const normalSession = api.session;
normalSession.original = normalSession;

test("kill switch is off by default: a drop removes the proxy as before", async () => {
  const s0 = (await send({ cmd: "state" })).value;
  assert.equal(s0.settings.killSwitch, false);
  await connected(false);
  api.session = () => failure(403, "DEVICE_OVER_LIMIT", over);
  const r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  assert.equal(proxyValue, null, "no proxy, no block");
  const s = (await send({ cmd: "state" })).value;
  assert.equal(s.connection.on, false);
  assert.ok(!s.connection.blocking);
  assert.ok(tabsOpened > 0, "the status page still opens");
  api.session = normalSession;
});

test("kill switch on: an unintended drop (device limit) blocks traffic instead of removing the proxy", async () => {
  await connected(true);
  api.session = () => failure(403, "DEVICE_OVER_LIMIT", over);
  const r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  assert.ok(isBlockingPac(), "the blocking PAC is installed");
  assert.equal(proxyValue.pacScript.mandatory, true);
  assert.equal(pac("example.com"), "PROXY 127.0.0.1:9");
  assert.equal(pac("fi.example.test"), "PROXY 127.0.0.1:9");
  assert.equal(pac("api.colitu.com"), "DIRECT", "the API stays reachable to sign in or reconnect");
  assert.equal(pac("192.168.1.10"), "DIRECT");
  assert.equal(pac("localhost"), "DIRECT");
  const s = (await send({ cmd: "state" })).value;
  assert.deepEqual([s.connection.on, s.connection.blocking], [false, true]);
  assert.ok(s.paused, "the pause is shown as before");
  assert.equal(badge, "!");
  api.session = normalSession;
});

test("blocked, then reconnected: the normal proxy replaces the block", async () => {
  // still paused and blocking from the previous test
  const r = await send({ cmd: "activate-device" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.value.connection.on, true);
  assert.ok(!r.value.connection.blocking);
  assert.ok(!isBlockingPac());
  assert.equal(pac("example.com"), "HTTPS fi.example.test:2083");
  assert.equal(badge, "FI");
});

test("blocked, then the session comes back on refresh: connected again without a click", async () => {
  api.session = () => failure(403, "ENTITLEMENT_EXPIRED");
  let r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "ENTITLEMENT_EXPIRED");
  assert.ok(isBlockingPac(), "plan ended: blocked");
  assert.equal((await send({ cmd: "state" })).value.connection.blocking, true);
  // a second failure while already blocked keeps the block
  r = await send({ cmd: "refresh" });
  assert.ok(isBlockingPac());
  api.session = normalSession;
  r = await send({ cmd: "refresh" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const s = (await send({ cmd: "state" })).value;
  assert.equal(s.connection.on, true);
  assert.ok(!s.connection.blocking);
  assert.equal(pac("example.com"), "HTTPS fi.example.test:2083");
});

test("the user disconnecting is not a drop: traffic is released, not blocked", async () => {
  await connected(true);
  const r = await send({ cmd: "disconnect" });
  assert.equal(r.value.connection.on, false);
  assert.ok(!r.value.connection.blocking);
  assert.equal(proxyValue, null);
  assert.equal(badge, "");
});

test("blocked: the user can allow traffic with a plain disconnect", async () => {
  await connected(true);
  api.session = () => failure(403, "QUOTA_EXCEEDED");
  await send({ cmd: "refresh" });
  assert.ok(isBlockingPac());
  api.session = normalSession;
  const r = await send({ cmd: "disconnect" });
  assert.ok(!r.value.connection.blocking);
  assert.equal(proxyValue, null);
});

test("blocked: turning the setting off releases traffic", async () => {
  await connected(true);
  api.session = () => failure(403, "ENTITLEMENT_INACTIVE");
  await send({ cmd: "refresh" });
  assert.ok(isBlockingPac());
  api.session = normalSession;
  const r = await send({ cmd: "settings", settings: { killSwitch: false } });
  assert.ok(!r.value.connection.blocking);
  assert.equal(proxyValue, null);
});

test("signing out yourself never blocks", async () => {
  await connected(true);
  const r = await send({ cmd: "sign-out" });
  assert.equal(r.value.signedIn, false);
  assert.ok(!r.value.connection.blocking);
  assert.equal(proxyValue, null);
});

test("losing the session (reused refresh token) blocks, and signing in again restores", async () => {
  await connected(true);
  api.session = () => failure(401, "AUTH_TOKEN_EXPIRED");
  api.refresh = () => failure(401, "AUTH_REFRESH_REUSED");
  const r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "AUTH_REFRESH_REUSED");
  const s = (await send({ cmd: "state" })).value;
  assert.equal(s.signedIn, false, "signed out locally");
  assert.equal(s.connection.blocking, true);
  assert.ok(isBlockingPac());
  assert.equal(pac("api.colitu.com"), "DIRECT", "the sign-in page can still reach the API");

  // Signing in again: the session is fetched and the proxy returns.
  api.session = normalSession;
  signIn();
  const again = await send({ cmd: "refresh" });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(again.value.connection.on, true);
  assert.equal(pac("example.com"), "HTTPS fi.example.test:2083");
});

test("a transient failure (network) does not drop or block anything", async () => {
  await connected(true);
  api.session = () => {
    throw new TypeError("offline");
  };
  const r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "NETWORK");
  assert.equal(pac("example.com"), "HTTPS fi.example.test:2083");
  assert.equal((await send({ cmd: "state" })).value.connection.on, true);
  api.session = normalSession;
  await send({ cmd: "disconnect" });
});

test("a too long split list is refused, not cut; the stored settings stay", async () => {
  signIn();
  await send({ cmd: "settings", settings: { split: "only", splitList: "kept.example" } });
  assert.equal(local.settings.splitList, "kept.example");
  // 500 valid domains of 55 characters: more than 20,000 characters.
  const long = Array.from({ length: 500 }, (_, i) => `${String(i).padStart(4, "0")}${"a".repeat(40)}.example.com`).join("\n");
  assert.ok(long.length > 20000);
  const r = await send({ cmd: "settings", settings: { split: "only", splitList: long } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "SPLIT_TOO_LONG");
  assert.equal(local.settings.splitList, "kept.example", "nothing was truncated into the settings");
  // More than 500 short entries are refused too (they used to be cut at 500).
  const many = Array.from({ length: 501 }, (_, i) => `s${i}.example`).join("\n");
  assert.ok(many.length < 20000);
  assert.equal((await send({ cmd: "settings", settings: { splitList: many } })).error.code, "SPLIT_TOO_LONG");
  // A list that fits is stored whole.
  const ok = Array.from({ length: 500 }, (_, i) => `s${i}.example`).join("\n");
  const fits = await send({ cmd: "settings", settings: { splitList: ok } });
  assert.equal(fits.ok, true);
  assert.equal(local.settings.splitList.split("\n").length, 500);
});

test("settings are type-checked and unknown keys are ignored", async () => {
  signIn();
  await send({ cmd: "settings", settings: { split: "off", splitList: "" } });
  const r = await send({ cmd: "settings", settings: { webrtc: "no", ruDirect: 0, autoConnect: "", killSwitch: 1, language: { x: 1 }, split: "bogus", splitList: 123, evil: true } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const s = local.settings;
  assert.equal(s.webrtc, true, "a non-empty string is true");
  assert.equal(s.ruDirect, false);
  assert.equal(s.autoConnect, false);
  assert.equal(s.killSwitch, true);
  assert.equal(s.language, "auto");
  assert.equal(s.split, "off");
  assert.equal(s.splitList, "", "a number is not a list");
  assert.ok(!("evil" in s));
  await send({ cmd: "settings", settings: { language: "tr", autoConnect: true, killSwitch: false } });
  assert.equal(local.settings.language, "tr");
  await send({ cmd: "settings", settings: { language: "klingon" } });
  assert.equal(local.settings.language, "auto");
});

test("the server list from the API is filtered before it is stored or used", async () => {
  signIn();
  api.session = () =>
    new Response(JSON.stringify({ ticket: "v1.t.s", expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), refresh_after: 3600, plan: null,
      servers: [{ ...servers[0] }, { ...servers[0], id: "evil", host: "x.test:443; DIRECT" }, { ...servers[0], id: "p", port: 99999 }, { ...servers[0], id: "num", host: "num.test", country: 12, name: null }] }), { status: 200 });
  const r = await send({ cmd: "refresh" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const list = (await send({ cmd: "state" })).value.session.servers;
  assert.deepEqual(list.map((s) => s.id), ["fi", "num"]);
  assert.equal(list[1].country, "12");
  // a numeric country must not break connecting (badge uses toUpperCase)
  const c = await send({ cmd: "connect", serverId: "num" });
  assert.equal(c.ok, true, JSON.stringify(c.error));
  assert.equal(badge, "12");
  assert.ok(!proxyValue.pacScript.data.includes("DIRECT\""), "the injected host never reaches the PAC chain");
  await send({ cmd: "disconnect" });
  api.session = normalSession;
});
