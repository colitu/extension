import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { buildRules, normalizeSites, pacScript, route } from "../src/lib/routing.js";

const servers = [{ host: "fi.example.test", port: 2083, country: "FI" }];

test("private, local and server hosts go direct", () => {
  const rules = buildRules({ ruDirect: false, mode: "all" }, servers, "FI");
  for (const host of ["localhost", "printer", "router.local", "10.0.0.1", "192.168.1.20", "172.20.1.1", "127.0.0.1", "169.254.169.254", "[::1]", "fd00::1", "fi.example.test", "nas.home.arpa"]) {
    assert.equal(route(rules, host), "direct", host);
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "www.youtube.com"]) {
    assert.equal(route(rules, host), "proxy", host);
  }
  assert.equal(route(rules, "api.colitu.com"), "fallback");
});

test("russian sites follow the server country", () => {
  const onFinland = buildRules({ ruDirect: true }, servers, "FI");
  const onRussia = buildRules({ ruDirect: true }, servers, "RU");
  assert.equal(route(onFinland, "yandex.ru"), "direct");
  assert.equal(route(onFinland, "xn--80ajghhoc2aj1c8b.xn--p1ai"), "direct");
  assert.equal(route(onFinland, "ru.wikipedia.org"), "proxy");
  assert.equal(route(onRussia, "yandex.ru"), "proxy");
});

test("only-listed mode and bypass list", () => {
  const rules = buildRules({ mode: "only", only: "https://www.YouTube.com/watch?v=1\ninstagram.com", bypass: "*.bank.example" }, servers, "FI");
  assert.deepEqual(rules.only, ["www.youtube.com", "instagram.com"]);
  assert.equal(route(rules, "www.youtube.com"), "proxy");
  assert.equal(route(rules, "cdn.instagram.com"), "proxy");
  assert.equal(route(rules, "example.com"), "direct");
  assert.equal(route(rules, "online.bank.example"), "direct");
  assert.equal(route(rules, "notinstagram.com"), "direct");
});

test("normalizeSites cleans user input", () => {
  assert.deepEqual(normalizeSites(" Example.com, http://a.b.example/x  *.c.example\n\nexample.com"), ["example.com", "a.b.example", "c.example"]);
  assert.deepEqual(normalizeSites("пример.рф"), ["xn--e1afmkfd.xn--p1ai"]);
});

test("PAC script decides like route() and never falls back to DIRECT for sites", () => {
  const rules = buildRules({ ruDirect: true, bypass: "skip.example" }, servers, "FI");
  const pac = pacScript(rules, [{ host: "fi.example.test", port: 2083 }, { host: "se.example.test", port: 2083 }]);
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  const find = (host) => vm.runInContext(`FindProxyForURL("https://${host}/", ${JSON.stringify(host)})`, ctx);
  assert.equal(find("example.com"), "HTTPS fi.example.test:2083; HTTPS se.example.test:2083");
  assert.equal(find("api.colitu.com"), "HTTPS fi.example.test:2083; HTTPS se.example.test:2083; DIRECT");
  assert.equal(find("skip.example"), "DIRECT");
  assert.equal(find("mail.ru"), "DIRECT");
  assert.equal(find("192.168.0.1"), "DIRECT");
});
