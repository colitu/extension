// Plan-end notice and the device-limit pause. The API fields are new, so
// parsing is tolerant: anything missing, null or of the wrong type is left
// out of the text instead of guessed. Plain functions, so they can be tested.

import { t, tn, language } from "./i18n.js";

const DAY = 24 * 3600 * 1000;
const NOTICE_WINDOW = 3 * DAY;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};
const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null);
const time = (v) => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

// planInfo merges the plan of /webproxy/session and /me/entitlement (either may
// be missing) into the few facts the popup needs. Earlier sources win.
export function planInfo(...sources) {
  const objs = sources.filter(isObj);
  const pick = (fn) => {
    for (const o of objs) {
      const v = fn(o);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const next = (o) => (isObj(o.next_plan) ? o.next_plan : {});
  const trialObj = (o) => (isObj(o.trial) ? o.trial : {});
  const endsAt = pick((o) => time(o.ends_at) ?? time(trialObj(o).ends_at) ?? time(o.trial_ends_at));
  if (endsAt === null) return null;
  const trial = objs.some((o) => o.trial === true || o.is_trial === true || isObj(o.trial) || /^trial/i.test(String(o.status || "")));
  const nextPlan = pick((o) => str(o.next_plan) ?? str(next(o).code) ?? str(next(o).name));
  const nextDevices = pick((o) => num(o.next_device_limit) ?? num(next(o).device_limit));
  const nextBytes = pick((o) => num(o.next_traffic_limit_bytes) ?? num(next(o).traffic_limit_bytes));
  const nextGb = pick((o) => num(o.next_traffic_limit_gb) ?? num(next(o).traffic_limit_gb)) ?? (nextBytes !== null ? gib(nextBytes) : null);
  const deviceCount = pick((o) => {
    const d = o.devices;
    return num(o.device_count) ?? num(o.devices_count) ?? num(o.active_device_count) ?? (isObj(d) ? num(d.used) ?? num(d.count) : Array.isArray(d) ? d.length : num(d));
  });
  return { endsAt, trial, nextPlan, nextGb, nextDevices, deviceCount };
}

function gib(bytes) {
  const v = bytes / 2 ** 30;
  return Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : Math.round(v * 10) / 10;
}

// Calendar days between now and the end, in local time: 0 today, 1 tomorrow.
function daysLeft(endsAt, now) {
  const a = new Date(now);
  const b = new Date(endsAt);
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(b) - day(a)) / DAY);
}

const plural = (key, n) => tn(key, n);

// noticeText returns the popup notice when the plan ends within 3 days, or "".
export function noticeText(info, now = Date.now()) {
  if (!info || !info.endsAt || info.endsAt <= now || info.endsAt - now > NOTICE_WINDOW) return "";
  const days = daysLeft(info.endsAt, now);
  const when = days <= 0 ? t("noticeToday") : days === 1 ? t("noticeTomorrow") : plural("noticeInDays", days);
  const parts = [t(info.trial ? "noticeTrialEnds" : "noticePlanEnds", { when })];
  if (info.nextPlan) {
    const details = [];
    if (info.nextGb !== null && info.nextGb !== undefined) details.push(t("noticeGb", { gb: info.nextGb.toLocaleString(language()) }));
    if (info.nextDevices !== null && info.nextDevices !== undefined) details.push(plural("devices", info.nextDevices));
    const extra = details.length ? ` (${details.join(", ")})` : "";
    parts.push(/^free$/i.test(info.nextPlan) || /^colitu-free$/i.test(info.nextPlan) ? t("noticeNextFree", { details: extra }) : t("noticeNextPlan", { plan: info.nextPlan, details: extra }));
  }
  if (info.nextDevices !== null && info.nextDevices !== undefined && info.deviceCount !== null && info.deviceCount !== undefined && info.deviceCount > info.nextDevices) {
    parts.push(t("noticeOthersPaused"));
  }
  return parts.join(" ");
}

// pausedInfo reads a DEVICE_OVER_LIMIT answer body.
export function pausedInfo(body) {
  const b = isObj(body) ? body : {};
  const e = isObj(b.error) ? b.error : {};
  const list = Array.isArray(b.active_devices) ? b.active_devices : Array.isArray(e.active_devices) ? e.active_devices : [];
  return {
    limit: num(b.device_limit) ?? num(e.device_limit),
    active: list
      .filter(isObj)
      .slice(0, 10)
      .map((d) => ({ id: str(d.id), name: str(d.name), lastSeenAt: str(d.last_seen_at) })),
  };
}

// pausedText is the sentence under the "This browser is paused" title.
export function pausedText(paused, thisDeviceId) {
  const p = paused || {};
  const parts = [p.limit !== null && p.limit !== undefined ? plural("pausedLimit", p.limit) : t("pausedLimitUnknown")];
  const names = (p.active || []).filter((d) => d.name && d.id !== thisDeviceId).map((d) => d.name);
  if (names.length) parts.push(t("pausedActive", { name: names.join(", ") }));
  return parts.join(" ");
}
