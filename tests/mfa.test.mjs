import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

// A fake extension storage and fetch, set up before api.js is loaded.
const stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
      set: async (values) => Object.assign(stored, values),
      remove: async (keys) => [].concat(keys).forEach((k) => delete stored[k]),
    },
  },
  runtime: { getManifest: () => ({ version: "1.1.0" }) },
};

const calls = [];
let answers = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
  const [status, body] = answers.shift();
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

const api = await import("../src/lib/api.js");

// header.payload.signature with an exp claim, as the API sends it.
const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
const tokens = { access_token: jwt(Math.floor(Date.now() / 1000) + 600), refresh_token: "r1", expires_in: 600 };

beforeEach(() => {
  calls.length = 0;
  answers = [];
  for (const k of Object.keys(stored)) delete stored[k];
});

test("login announces 2FA support and returns the challenge without storing it", async () => {
  answers.push([403, { error: { code: "MFA_REQUIRED" }, mfa_token: "mfa-abc", mfa_expires_in: 300 }]);
  const challenge = await api.login("a@example.test", "pw");
  assert.deepEqual(challenge, { token: "mfa-abc", expiresIn: 300 });
  assert.equal(calls[0].url, api.API_BASE + "/auth/login");
  assert.equal(calls[0].init.headers["X-Colitu-Features"], "mfa");
  assert.deepEqual(stored, {});
});

test("login without 2FA stores the session as before", async () => {
  answers.push([200, tokens]);
  assert.equal(await api.login("a@example.test", "pw"), null);
  assert.equal(stored.auth.refresh, "r1");
  assert.equal(stored.auth.email, "a@example.test");
});

test("MFA_REQUIRED without a challenge token is an error", async () => {
  answers.push([403, { error: { code: "MFA_REQUIRED" } }]);
  await assert.rejects(api.login("a@example.test", "pw"), { code: "MFA_REQUIRED" });
});

test("old-client answer is passed through as its code", async () => {
  answers.push([403, { error: { code: "MFA_REQUIRED_UPDATE_APP" } }]);
  await assert.rejects(api.login("a@example.test", "pw"), { code: "MFA_REQUIRED_UPDATE_APP", status: 403 });
});

test("loginMfa sends the challenge and code, then stores the session", async () => {
  answers.push([200, tokens]);
  await api.loginMfa("mfa-abc", "123456", "a@example.test");
  assert.equal(calls[0].url, api.API_BASE + "/auth/login/mfa");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { mfa_token: "mfa-abc", code: "123456" });
  assert.equal(stored.auth.refresh, "r1");
  assert.equal(stored.auth.email, "a@example.test");
  assert.ok(!JSON.stringify(stored).includes("mfa-abc"));
});

test("loginMfa errors keep their codes", async () => {
  for (const [status, code] of [[401, "MFA_INVALID_CODE"], [401, "MFA_TOKEN_EXPIRED"], [429, "RATE_LIMITED"]]) {
    answers.push([status, { error: { code } }]);
    await assert.rejects(api.loginMfa("mfa-abc", "000000", "a@example.test"), { code, status });
  }
  assert.deepEqual(stored, {});
});

test("the popup has the 2FA view and no inline scripts or handlers", () => {
  const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
  assert.match(html, /<section class="view" id="view-mfa"/);
  assert.match(html, /id="in-mfa-code"[^>]*autocomplete="one-time-code"/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.match(html, /<script type="module" src="popup.js"><\/script>/);
});
