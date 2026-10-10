// Audit findings 1, 5, 6, 9: the token refresh race, the server list check,
// bounded API answers and the device-link poll.
import assert from "node:assert/strict";
import { test } from "node:test";

const stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in stored).map((x) => [x, structuredClone(stored[x])])),
      set: async (v) => Object.assign(stored, structuredClone(v)),
      remove: async (k) => [].concat(k).forEach((x) => delete stored[x]),
    },
  },
  runtime: { getManifest: () => ({ version: "1.3.0" }) },
};

const jwt = (n) => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 + n })).toString("base64url")}.y`;
const api = await import("../src/lib/api.js");
const json = (status, body) => new Response(JSON.stringify(body), { status });
const apiError = (status, code) => json(status, { error: { code, message: code } });

test("two requests that both get a 401 refresh the token once and stay signed in", async () => {
  const stale = jwt(-5);
  stored.auth = { access: stale, refresh: "R1", accessExp: Date.now() + 600e3, deviceId: "d1" };
  // A rotating refresh token: the first use works, any later use is a reuse.
  const log = [];
  const used = new Set();
  let current = "R1";
  let access = jwt(100); // the server already moved on: the stored token is stale
  let staleCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.colitu.com/api/v1", "");
    if (path === "/auth/refresh") {
      const sent = JSON.parse(init.body).refresh_token;
      log.push(`refresh with ${sent}`);
      if (used.has(sent)) return apiError(401, "AUTH_REFRESH_REUSED");
      used.add(sent);
      current = "R" + (used.size + 1);
      access = jwt(used.size);
      return json(200, { access_token: access, refresh_token: current, expires_in: 600 });
    }
    const fresh = init.headers.Authorization === `Bearer ${access}`;
    if (!fresh) {
      staleCalls++;
      // The second request only gets its 401 after the first one has finished
      // refreshing: it now holds an outdated copy of the session.
      if (staleCalls === 2) await new Promise((r) => setTimeout(r, 80));
      return apiError(401, "AUTH_TOKEN_EXPIRED");
    }
    return json(200, { ok: true });
  };
  const [a, b] = await Promise.all([api.authorized("/x"), api.authorized("/x")]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.deepEqual(log, ["refresh with R1"], "the old refresh token is never sent twice");
  assert.equal(stored.auth.refresh, "R2");
  assert.equal(current, "R2");
});

test("a reuse answer is not terminal while the stored refresh token already changed", async () => {
  stored.auth = { access: jwt(-5), refresh: "R1", accessExp: 0, deviceId: "d1" };
  const newer = jwt(50);
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth/refresh")) {
      // Another context rotates the session while this refresh is on the wire.
      stored.auth = { access: newer, refresh: "R9", accessExp: Date.now() + 600e3, deviceId: "d1" };
      return apiError(401, "AUTH_REFRESH_REUSED");
    }
    assert.equal(init.headers.Authorization, `Bearer ${newer}`, "the retry uses the newer session");
    return json(200, { ok: true });
  };
  assert.deepEqual(await api.authorized("/x"), { ok: true });
  assert.equal(stored.auth.refresh, "R9", "the newer session stays");
});

test("a reuse answer for the token still in storage stays terminal", async () => {
  stored.auth = { access: jwt(-5), refresh: "R1", accessExp: 0, deviceId: "d1" };
  globalThis.fetch = async () => apiError(401, "AUTH_REFRESH_REUSED");
  await assert.rejects(api.authorized("/x"), (err) => api.isTerminal(err) && err.code === "AUTH_REFRESH_REUSED");
});

test("server list: host names and ports are checked, bad entries dropped, texts become strings", () => {
  const good = { id: "fi", name: "Helsinki", country: "FI", city: "Helsinki", host: "FI.Example.test", port: 2083, load: "medium" };
  const list = api.sanitizeServers([
    good,
    { ...good, id: "inj", host: "x.test:443; DIRECT" },
    { ...good, id: "sp", host: "x.test DIRECT" },
    { ...good, id: "slash", host: "x.test/path" },
    { ...good, id: "empty", host: "" },
    { ...good, id: "p0", port: 0 },
    { ...good, id: "p70k", port: 70000 },
    { ...good, id: "pstr", port: "443; DIRECT" },
    { ...good, id: "pfrac", port: 80.5 },
    { ...good, id: "num", name: 5, country: 12, city: { a: 1 }, host: "ok.test", port: 443, load: "weird" },
    null,
    "text",
  ]);
  assert.deepEqual(list.map((s) => s.id), ["fi", "num"]);
  assert.equal(list[0].host, "fi.example.test");
  assert.equal(list[1].country, "12");
  assert.equal(list[1].name, "5");
  assert.equal(typeof list[1].city, "string");
  assert.equal(list[1].load, "low");
  assert.deepEqual(api.sanitizeServers(undefined), []);
  assert.deepEqual(api.sanitizeServers({ not: "an array" }), []);
});

test("an oversized answer is cancelled while streaming, not read whole", async () => {
  stored.auth = { access: jwt(5), refresh: "R1", accessExp: Date.now() + 600e3, deviceId: "d1" };
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  await assert.rejects(api.entitlement(), (err) => err.code === "RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true);
  assert.ok(pulled <= 8, `read ${pulled} chunks of an endless answer`);
});

test("a declared oversized answer is refused before reading", async () => {
  stored.auth = { access: jwt(5), refresh: "R1", accessExp: Date.now() + 600e3, deviceId: "d1" };
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-length": String(5 << 20) } });
  await assert.rejects(api.entitlement(), (err) => err.code === "RESPONSE_TOO_LARGE");
});

test("a normal answer still parses", async () => {
  stored.auth = { access: jwt(5), refresh: "R1", accessExp: Date.now() + 600e3, deviceId: "d1" };
  globalThis.fetch = async () => json(200, { status: "ok", text: "çalışıyor" });
  assert.deepEqual(await api.entitlement(), { status: "ok", text: "çalışıyor" });
});

test("linkPoll goes through the shared request: 202 waits, 200 stores the session, errors carry the code", async () => {
  delete stored.auth;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 202 });
  };
  assert.equal(await api.linkPoll("poll-1"), null);
  assert.equal(seen.init.redirect, "error", "same safeguards as every other call");
  assert.ok(seen.init.signal, "has a timeout");
  assert.equal(JSON.parse(seen.init.body).poll_token, "poll-1");

  globalThis.fetch = async () => json(200, { access_token: jwt(1), refresh_token: "LR1", expires_in: 600 });
  assert.equal(await api.linkPoll("poll-1"), true);
  assert.equal(stored.auth.refresh, "LR1");

  globalThis.fetch = async () => apiError(403, "LINK_DENIED");
  await assert.rejects(api.linkPoll("poll-1"), (err) => err.code === "LINK_DENIED");

  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  await assert.rejects(api.linkPoll("poll-1"), (err) => err.code === "NETWORK", "a network failure is retried by the loop");

  globalThis.fetch = async () => new Response("x".repeat((1 << 20) + 10), { status: 200 });
  await assert.rejects(api.linkPoll("poll-1"), (err) => err.code === "RESPONSE_TOO_LARGE");
});

test("the poll interval is clamped to 2..60 seconds", () => {
  assert.equal(api.linkInterval(3), 3);
  assert.equal(api.linkInterval(1), 2);
  assert.equal(api.linkInterval(0), 3);
  assert.equal(api.linkInterval(1e9), 60);
  assert.equal(api.linkInterval(Infinity), 3);
  assert.equal(api.linkInterval("45"), 45);
  assert.equal(api.linkInterval(undefined), 3);
  assert.equal(api.linkInterval({}), 3);
});
