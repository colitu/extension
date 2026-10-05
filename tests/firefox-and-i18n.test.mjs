import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dictionaries } from "../src/lib/i18n.js";
import { firefoxDecision, remember } from "../src/lib/proxy.js";
import { buildRules } from "../src/lib/routing.js";

test("Firefox gets the same decision with the ticket as proxy credentials", () => {
  const servers = [{ host: "fi.example.test", port: 2083, country: "FI" }];
  assert.deepEqual(firefoxDecision("https://example.com/"), { type: "direct" });
  remember(buildRules({ ruDirect: true }, servers, "FI"), [{ host: "fi.example.test", port: 2083 }], "v1.payload.sig");
  const chain = firefoxDecision("https://example.com/path");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].type, "https");
  assert.equal(chain[0].host, "fi.example.test");
  assert.equal(Buffer.from(chain[0].proxyAuthorizationHeader.slice(6), "base64").toString(), "colitu:v1.payload.sig");
  assert.deepEqual(firefoxDecision("https://yandex.ru/"), { type: "direct" });
  assert.equal(firefoxDecision("https://api.colitu.com/x").at(-1).type, "direct");
  remember(null, null, null);
});

test("every UI string exists in every language and placeholders match", () => {
  const { en } = dictionaries;
  for (const [lang, dict] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), lang);
    for (const key of Object.keys(en)) {
      const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(vars(dict[key]), vars(en[key]), `${lang}.${key}`);
    }
  }
});

test("every key used in the popup is defined", () => {
  const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../src/popup/popup.js", import.meta.url), "utf8");
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of js.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]);
  for (const key of used) assert.ok(key in dictionaries.en, key);
});
