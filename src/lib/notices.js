// In-app notices from the panel (GET /client/notices): usage warnings and
// campaigns shown as one banner in the popup. The background fetches them at
// most every 15 minutes; what was dismissed or already reported is kept in
// extension storage (newest 200 ids each).

import { load, save } from "./store.js";

export const FETCH_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_IDS = 200;
export const LEVELS = ["info", "promo", "warning", "critical"];

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// parseNotices: the API answer -> clean notices. Broken entries are dropped;
// anything that is not {"notices":[...]} means "none". The push flag is
// ignored (the extension shows no system notifications).
export function parseNotices(data) {
  const list = data && Array.isArray(data.notices) ? data.notices : [];
  const out = [];
  for (const item of list.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const id = text(item.id, 200);
    const title = text(item.title, 300);
    const body = text(item.body, 2000);
    if (!id || (!title && !body)) continue;
    const expires = item.expires_at ? Date.parse(item.expires_at) : NaN;
    out.push({
      id,
      kind: text(item.kind, 40),
      level: LEVELS.includes(item.level) ? item.level : "info",
      title,
      body,
      button: text(item.button, 100) || null,
      url: text(item.url, 2000) || null,
      expiresAt: Number.isFinite(expires) ? expires : null,
    });
  }
  return out;
}

// pickNext: the first notice that is neither dismissed nor expired.
export function pickNext(list, dismissed, now = Date.now()) {
  const gone = dismissed instanceof Set ? dismissed : new Set(dismissed);
  return list.find((n) => !gone.has(n.id) && !(n.expiresAt !== null && n.expiresAt <= now)) || null;
}

// addCappedId: appends the id (newest last) and keeps the newest `max`.
export function addCappedId(ids, id, max = MAX_IDS) {
  const next = ids.filter((x) => x !== id);
  next.push(id);
  return next.length > max ? next.slice(next.length - max) : next;
}

async function idList(key) {
  const value = (await load([key]))[key];
  return Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
}

// One call at a time: two popups opened together must not report twice.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// current returns the notice to show (or null). `fetchList(lang)` returns the
// raw API answer; `report(id, event)` posts an event. Both may fail: that
// means "no notice" / "not reported", never an error for the caller.
export function current({ fetchList, report, lang, deviceId, now = Date.now() }) {
  return serial(async () => {
    const { noticeCache: cache } = await load(["noticeCache"]);
    const fresh = cache && cache.deviceId === deviceId && cache.lang === lang && Array.isArray(cache.list) &&
      cache.at <= now && now - cache.at < FETCH_INTERVAL_MS;
    let list;
    if (fresh) {
      list = cache.list;
    } else {
      try {
        list = parseNotices(await fetchList(lang));
      } catch {
        list = []; // an older panel (404), offline, signed out: no notice
      }
      await save({ noticeCache: { at: now, lang, deviceId, list } });
    }
    const notice = pickNext(list, await idList("noticeDismissed"), now);
    if (notice) {
      const seen = await idList("noticeSeen");
      if (!seen.includes(notice.id)) {
        await save({ noticeSeen: addCappedId(seen, notice.id) });
        report(notice.id, "seen").catch(() => {});
      }
    }
    return notice;
  });
}

// dismiss remembers the id and reports it; the caller asks for the next one.
export function dismiss({ id, report }) {
  return serial(async () => {
    await save({ noticeDismissed: addCappedId(await idList("noticeDismissed"), id) });
    report(id, "dismissed").catch(() => {});
  });
}

export function clicked({ id, report }) {
  return report(id, "clicked").catch(() => {});
}
