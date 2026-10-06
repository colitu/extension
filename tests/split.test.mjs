// Split tunneling: list validation, rule generation, and the same decision in
// Chrome (PAC script) and Firefox (proxy.onRequest).
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const stored = {};
globalThis.chrome = {
  storage: { local: { get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in stored).map((x) => [x, stored[x]])), set: async (v) => Object.assign(stored, v), remove: async () => {} } },
};
const { buildRules, migrateSplit, pacScript, parseNet, parseSplitList, route, splitSettings, formatNet } = await import("../src/lib/routing.js");
const { firefoxDecision, remember } = await import("../src/lib/proxy.js");
const { settings: loadSettings } = await import("../src/lib/store.js");

const servers = [{ host: "fi.example.test", port: 2083, country: "FI" }];
const hops = [{ host: "fi.example.test", port: 2083 }, { host: "se.example.test", port: 2083 }];
const CHAIN = "HTTPS fi.example.test:2083; HTTPS se.example.test:2083";
const LIST = "bank.example\nhttps://www.Video.example/watch?v=1\n*.shop.example\n203.0.113.0/24\n198.51.100.7\n2001:db8:abcd::/48\n[2001:db8::42]:443";

// Chrome: run the generated PAC script; Firefox: ask firefoxDecision.
function chromeDecision(rules, host) {
  const ctx = vm.createContext({});
  vm.runInContext(pacScript(rules, hops), ctx);
  return vm.runInContext(`FindProxyForURL("https://x/", ${JSON.stringify(host)})`, ctx);
}
function firefox(rules, host) {
  remember(rules, hops, "v1.t.s");
  const d = firefoxDecision(`https://${host.includes(":") ? `[${host}]` : host}/`);
  remember(null, null, null);
  if (!Array.isArray(d)) return d.type === "direct" ? "DIRECT" : "?";
  return d.map((p) => (p.type === "direct" ? "DIRECT" : `HTTPS ${p.host}:${p.port}`)).join("; ");
}
function both(rules, host) {
  const c = chromeDecision(rules, host);
  assert.equal(firefox(rules, host), c, `Chrome and Firefox differ for ${host}`);
  return c === "DIRECT" ? "direct" : c === CHAIN ? "proxy" : c === CHAIN + "; DIRECT" ? "fallback" : c;
}

test("the list accepts domains, IPv4/IPv6 addresses and CIDR ranges, and names what is invalid", () => {
  const p = parseSplitList(LIST + "\n999.1.1.1 1.2.3 bad_host -x.com 10.0.0.0/33 2001:db8::/129 fe80::1::2 пример.рф BANK.example");
  assert.deepEqual(p.sites, ["bank.example", "www.video.example", "shop.example", "xn--e1afmkfd.xn--p1ai"]);
  assert.deepEqual(p.nets.map(formatNet), ["203.0.113.0/24", "198.51.100.7", "2001:db8:abcd::/48", "2001:db8::42"]);
  assert.deepEqual(p.invalid, ["999.1.1.1", "1.2.3", "bad_host", "-x.com", "10.0.0.0/33", "2001:db8::/129", "fe80::1::2"]);
  // Host bits are cleared, so the stored range is what is matched.
  assert.equal(formatNet(parseNet("198.51.100.77/24")), "198.51.100.0/24");
  assert.equal(formatNet(parseNet("2001:db8:1:2:3:4:5:6/32")), "2001:db8::/32");
  assert.equal(parseSplitList(Array.from({ length: 600 }, (_, i) => `s${i}.example`).join("\n")).entries.length, 500);
});

test("off: everything uses Colitu", () => {
  const rules = buildRules({ split: "off", splitList: LIST, ruDirect: false }, servers, "FI");
  assert.deepEqual([rules.bypass, rules.only, rules.mode], [[], [], "all"]);
  for (const host of ["bank.example", "203.0.113.5", "example.org"]) assert.equal(both(rules, host), "proxy", host);
});

test("selected sites bypass the proxy (Chrome and Firefox)", () => {
  const rules = buildRules({ split: "bypass", splitList: LIST, ruDirect: false }, servers, "FI");
  const expect = {
    "bank.example": "direct",
    "online.bank.example": "direct", // suffix match
    "notbank.example": "proxy",
    "www.video.example": "direct",
    "video.example": "proxy", // the entry was www.video.example
    "a.shop.example": "direct",
    "203.0.113.200": "direct",
    "203.0.114.1": "proxy",
    "198.51.100.7": "direct",
    "198.51.100.8": "proxy",
    "2001:db8:abcd:12::1": "direct",
    "2001:db8:abce::1": "proxy",
    "2001:db8::42": "direct",
    "example.org": "proxy",
    "api.colitu.com": "fallback",
    "192.168.1.1": "direct", // local addresses stay direct
  };
  for (const [host, want] of Object.entries(expect)) assert.equal(both(rules, host), want, host);
});

test("only selected sites use the proxy (Chrome and Firefox)", () => {
  const rules = buildRules({ split: "only", splitList: LIST + "\nyandex.ru", ruDirect: true }, servers, "FI");
  const expect = {
    "bank.example": "proxy",
    "m.bank.example": "proxy",
    "example.org": "direct",
    "203.0.113.9": "proxy",
    "8.8.8.8": "direct",
    "2001:db8:abcd::99": "proxy",
    "2606:4700::1111": "direct",
    "yandex.ru": "proxy", // the user's list wins over "Russian sites directly"
    "mail.ru": "direct",
    "api.colitu.com": "fallback",
    "fi.example.test": "direct",
  };
  for (const [host, want] of Object.entries(expect)) assert.equal(both(rules, host), want, host);
});

test("only with an empty list counts as off, so nothing is silently unprotected", () => {
  const s = splitSettings({ split: "only", splitList: "  \n" });
  assert.deepEqual([s.mode, s.count], ["off", 0]);
  const rules = buildRules({ split: "only", splitList: "" }, servers, "FI");
  assert.equal(both(rules, "example.org"), "proxy");
  assert.deepEqual(splitSettings({ split: "bypass", splitList: LIST }).count, 7);
  assert.equal(splitSettings({ split: "nonsense", splitList: LIST }).mode, "off");
});

test("1.0.0 settings and stored rules keep working", async () => {
  assert.deepEqual(migrateSplit({ mode: "only", only: "a.example", bypass: "b.example" }), { split: "only", splitList: "a.example" });
  assert.deepEqual(migrateSplit({ mode: "all", only: "a.example", bypass: "b.example" }), { split: "bypass", splitList: "b.example" });
  assert.deepEqual(migrateSplit({ mode: "all", bypass: "" }), { split: "off", splitList: "" });
  // Rules saved by 1.0.0 (no *Nets fields) are still routed.
  const old = { servers: ["fi.example.test"], bypass: ["b.example"], only: [], mode: "all", ruDirect: false, api: ["api.colitu.com"] };
  assert.equal(route(old, "x.b.example"), "direct");
  assert.equal(route(old, "203.0.113.1"), "proxy");
  stored.settings = { webrtc: true, mode: "only", only: "a.example", bypass: "" };
  const s = await loadSettings();
  assert.equal(s.split, "only");
  assert.equal(s.splitList, "a.example");
  assert.ok(!("mode" in s) && !("only" in s) && !("bypass" in s));
});

test("the PAC script is self-contained", () => {
  const rules = buildRules({ split: "bypass", splitList: "203.0.113.0/24 2001:db8::/32" }, servers, "FI");
  const pac = pacScript(rules, hops);
  // Only the PAC sandbox globals: nothing from this module may leak in.
  const ctx = vm.createContext({ Math, String, parseInt, Array, RegExp });
  vm.runInContext(pac, ctx);
  assert.equal(vm.runInContext(`FindProxyForURL("http://[2001:db8::5]/", "2001:db8::5")`, ctx), "DIRECT");
  assert.equal(vm.runInContext(`FindProxyForURL("http://203.0.113.4/", "203.0.113.4")`, ctx), "DIRECT");
  assert.doesNotMatch(pac, /dnsResolve|isInNet|myIpAddress/);
});
