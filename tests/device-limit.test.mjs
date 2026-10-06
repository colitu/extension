// The background with a fake browser and API: a DEVICE_OVER_LIMIT answer
// turns the proxy off and pauses the browser; "Use this browser instead"
// activates it and connects again.
import assert from "node:assert/strict";
import { test } from "node:test";

const local = {};
const area = (o) => ({
  get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in o).map((x) => [x, o[x]])),
  set: async (v) => Object.assign(o, structuredClone(v)),
  remove: async (k) => [].concat(k).forEach((x) => delete o[x]),
});
const ev = () => ({ addListener() {} });
let onMessage;
let proxyOn = false;
globalThis.chrome = {
  storage: { local: area(local), session: area({}) },
  runtime: { getManifest: () => ({ version: "1.1.0" }), onMessage: { addListener: (f) => (onMessage = f) }, onStartup: ev(), onInstalled: ev() },
  webRequest: { onAuthRequired: ev() },
  proxy: {
    onProxyError: ev(),
    settings: {
      get: async () => ({ levelOfControl: "controllable_by_this_extension" }),
      set: async () => (proxyOn = true),
      clear: async () => (proxyOn = false),
    },
  },
  alarms: { onAlarm: ev(), create() {}, clear() {} },
  action: { setIcon: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  extension: { isAllowedIncognitoAccess: async () => true },
  privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } },
  i18n: { getUILanguage: () => "en" },
  tabs: { create() {} },
};

const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.y`;
const answers = [];
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = url.replace(/^https:\/\/api\.colitu\.com\/api\/v1/, "");
  if (!url.startsWith("https://api.colitu.com/")) throw new Error("offline"); // pings, whoami
  calls.push({ path, method: init.method || "GET", headers: init.headers || {} });
  const next = answers.shift();
  assert.ok(next, `unexpected call ${path}`);
  assert.equal(path, next[0]);
  return new Response(JSON.stringify(next[2]), { status: next[1] });
};

const servers = [{ id: "fi", name: "Helsinki", country: "fi", city: "Helsinki", host: "fi.example.test", port: 2083, load: "low" }];
const okSession = () => ["/webproxy/session", 200, { ticket: "v1.t.s", expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), refresh_after: 3600, servers, plan: { status: "trialing", traffic_limit_bytes: null } }];
const over = { error: { code: "DEVICE_OVER_LIMIT", message: "device paused" }, device_limit: 1, active_devices: [{ id: "dev2", name: "Pixel 8", last_seen_at: "2026-10-06T09:00:00Z" }] };

local.auth = { access: jwt, refresh: "r", accessExp: Date.now() + 600e3, deviceId: "dev1", email: "a@b.test" };
await import("../src/background.js");
const send = (msg) => new Promise((res) => onMessage(msg, {}, res));

test("connect, then a paused device turns the proxy off", async () => {
  answers.push(okSession(), ["/me/entitlement", 200, { status: "trialing", ends_at: new Date(Date.now() + 2 * 864e5).toISOString(), next_plan: "free", next_device_limit: 1, devices: { used: 2 } }]);
  let r = await send({ cmd: "connect", serverId: "auto" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.value.connection.on, true);
  assert.equal(proxyOn, true);
  assert.equal(r.value.entitlement.next_plan, "free");
  assert.equal(calls.find((c) => c.path === "/me/entitlement").headers["X-Device-ID"], "dev1");

  answers.push(["/webproxy/session", 403, over]);
  r = await send({ cmd: "refresh" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  const s = (await send({ cmd: "state" })).value;
  assert.equal(proxyOn, false, "proxy must be off while paused");
  assert.equal(s.connection.on, false);
  assert.equal(local.session.ticket, "");
  assert.deepEqual(s.paused, { limit: 1, active: [{ id: "dev2", name: "Pixel 8", lastSeenAt: "2026-10-06T09:00:00Z" }], deviceId: "dev1" });
});

test("connecting while paused asks the API again and stays off", async () => {
  answers.push(["/webproxy/session", 403, over]);
  const r = await send({ cmd: "connect", serverId: "auto" });
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  assert.equal(proxyOn, false);
  assert.ok((await send({ cmd: "state" })).value.paused);
});

test("use this browser instead: activate, fetch the session, reconnect", async () => {
  calls.length = 0;
  answers.push(["/devices/dev1/activate", 200, { id: "dev1", status: "active" }], okSession(), ["/me/entitlement", 200, { status: "trialing" }]);
  const r = await send({ cmd: "activate-device" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, `Bearer ${jwt}`);
  assert.equal(r.value.paused, null);
  assert.equal(r.value.connection.on, true, "the pause had turned the connection off, so it comes back");
  assert.equal(proxyOn, true);
  assert.equal(r.value.status.error, null);
});

test("a paused answer from /me/entitlement pauses too", async () => {
  answers.push(okSession(), ["/me/entitlement", 403, over]);
  const r = await send({ cmd: "refresh" });
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  assert.equal(proxyOn, false);
  assert.ok((await send({ cmd: "state" })).value.paused);
});

test("activation refused again keeps the pause", async () => {
  answers.push(["/devices/dev1/activate", 403, over]);
  const r = await send({ cmd: "activate-device" });
  assert.equal(r.error.code, "DEVICE_OVER_LIMIT");
  assert.equal(proxyOn, false);
  assert.ok((await send({ cmd: "state" })).value.paused);
  assert.equal(answers.length, 0);
});
