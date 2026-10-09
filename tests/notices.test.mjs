import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// A fake extension storage, set up before notices.js (store.js) is loaded.
const stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in stored).map((k) => [k, stored[k]])),
      set: async (values) => Object.assign(stored, values),
      remove: async (keys) => [].concat(keys).forEach((k) => delete stored[k]),
    },
  },
  runtime: { getManifest: () => ({ version: "1.1.2" }) },
};

const { parseNotices, pickNext, addCappedId, current, dismiss, clicked, FETCH_INTERVAL_MS } = await import("../src/lib/notices.js");

const n = (id, extra = {}) => ({ id, kind: "campaign", level: "info", title: `T ${id}`, body: `B ${id}`, ...extra });

let fetches;
let events;
let answer;
const ctx = (over = {}) => ({
  fetchList: async (lang) => {
    fetches.push(lang);
    if (answer instanceof Error) throw answer;
    return answer;
  },
  report: async (id, event) => {
    events.push(`${id}|${event}`);
  },
  lang: "tr",
  deviceId: "dev1",
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(stored)) delete stored[k];
  fetches = [];
  events = [];
  answer = { notices: [] };
});

test("parseNotices reads the contract and drops broken entries", () => {
  const list = parseNotices({
    notices: [
      { id: "usage_80:1790812800", kind: "usage", level: "warning", title: "Title", body: "Body", button: "Upgrade", url: "https://colitu.com/pricing", push: true, expires_at: "2026-11-01T00:00:00Z" },
      { id: "x", level: "weird", title: "Only title" },
      { title: "no id" },
      { id: "empty" },
      42,
    ],
  });
  assert.deepEqual(list.map((x) => x.id), ["usage_80:1790812800", "x"]);
  assert.equal(list[0].level, "warning");
  assert.equal(list[0].button, "Upgrade");
  assert.equal(list[0].expiresAt, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(list[1].level, "info");
  assert.equal(list[1].button, null);
  assert.deepEqual(parseNotices(null), []);
  assert.deepEqual(parseNotices({ notices: "x" }), []);
});

test("pickNext skips dismissed and expired notices", () => {
  const list = [n("a"), n("b", { expiresAt: 1000 }), n("c", { expiresAt: 5000 }), n("d")];
  assert.equal(pickNext(list, new Set(), 2000).id, "a");
  assert.equal(pickNext(list, ["a"], 2000).id, "c");
  assert.equal(pickNext(list, ["a", "c"], 2000).id, "d");
  assert.equal(pickNext(list, ["a", "c", "d"], 2000), null);
  assert.equal(pickNext([], [], 0), null);
});

test("addCappedId keeps the newest 200 without duplicates", () => {
  let ids = [];
  for (let i = 0; i < 250; i++) ids = addCappedId(ids, `n${i}`);
  assert.equal(ids.length, 200);
  assert.equal(ids[0], "n50");
  assert.equal(ids.at(-1), "n249");
  assert.deepEqual(addCappedId(["a", "b"], "a"), ["b", "a"]);
});

test("current shows the first notice, reports seen once and dismiss moves on", async () => {
  answer = { notices: [{ id: "a:1", title: "A", body: "x" }, { id: "b:2", title: "B", body: "y" }] };
  const now = 1_000_000;
  assert.equal((await current(ctx({ now }))).id, "a:1");
  assert.deepEqual(events, ["a:1|seen"]);
  assert.deepEqual(stored.noticeSeen, ["a:1"]);

  await current(ctx({ now: now + 1000 }));
  assert.deepEqual(events, ["a:1|seen"], "seen is reported once per id");
  assert.equal(fetches.length, 1, "served from the cache");

  await dismiss({ id: "a:1", report: ctx().report });
  assert.deepEqual(stored.noticeDismissed, ["a:1"]);
  assert.equal((await current(ctx({ now: now + 2000 }))).id, "b:2");
  assert.deepEqual(events, ["a:1|seen", "a:1|dismissed", "b:2|seen"]);

  await clicked({ id: "b:2", report: ctx().report });
  assert.equal(events.at(-1), "b:2|clicked");
});

test("a dismissed id stays dismissed after a refetch", async () => {
  answer = { notices: [n("a")] };
  stored.noticeDismissed = ["a"];
  assert.equal(await current(ctx({ now: 1 })), null);
  assert.deepEqual(events, []);
});

test("fetches at most every 15 minutes and refetches for another language or device", async () => {
  const t0 = 5_000_000;
  await current(ctx({ now: t0 }));
  await current(ctx({ now: t0 + FETCH_INTERVAL_MS - 1 }));
  assert.equal(fetches.length, 1);
  await current(ctx({ now: t0 + FETCH_INTERVAL_MS }));
  assert.equal(fetches.length, 2);
  await current(ctx({ now: t0 + FETCH_INTERVAL_MS, lang: "en" }));
  assert.equal(fetches.length, 3);
  await current(ctx({ now: t0 + FETCH_INTERVAL_MS, lang: "en", deviceId: "dev2" }));
  assert.equal(fetches.length, 4);
});

test("an API error (older panel, offline) means no notice, silently", async () => {
  answer = new Error("404");
  assert.equal(await current(ctx({ now: 10 })), null);
  assert.equal(await current(ctx({ now: 20 })), null);
  assert.equal(fetches.length, 1, "the failure is cached for the interval too");
});

test("a failing event report does not break the banner", async () => {
  answer = { notices: [n("a")] };
  const report = async () => {
    throw new Error("offline");
  };
  assert.equal((await current(ctx({ report, now: 1 }))).id, "a");
  await dismiss({ id: "a", report });
  assert.deepEqual(stored.noticeDismissed, ["a"]);
});
