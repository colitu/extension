import assert from "node:assert/strict";
import { test } from "node:test";
import { setLanguage } from "../src/lib/i18n.js";
import { noticeText, pausedInfo, pausedText, planInfo } from "../src/lib/plan.js";

const DAY = 24 * 3600 * 1000;
// Noon local time, so "in N days" does not depend on when the test runs.
const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
const at = (days) => new Date(now + days * DAY).toISOString();

test("trial ending in 2 days with more devices than the free plan allows", () => {
  setLanguage("en");
  const plan = { status: "trialing", expires_at: at(2), traffic_limit_bytes: null };
  const ent = { ends_at: at(2), next_plan: "free", next_device_limit: 1, next_traffic_limit_bytes: 10 * 2 ** 30, devices: { used: 3, limit: 5 } };
  assert.equal(
    noticeText(planInfo(plan, ent), now),
    "Your trial ends in 2 days. You'll move to the free plan (10 GB a month, 1 device). The device you used most recently stays active; the others are paused.",
  );
});

test("simpler text when the devices fit the next plan", () => {
  setLanguage("en");
  const info = planInfo({ status: "trialing" }, { ends_at: at(1), next_plan: "free", next_device_limit: 1, next_traffic_limit_bytes: 10 * 2 ** 30, device_count: 1 });
  assert.equal(noticeText(info, now), "Your trial ends tomorrow. You'll move to the free plan (10 GB a month, 1 device).");
});

test("numbers that are missing are left out, never guessed", () => {
  setLanguage("en");
  assert.equal(noticeText(planInfo({ status: "trialing", ends_at: at(3), next_plan: "free" }), now), "Your trial ends in 3 days. You'll move to the free plan.");
  assert.equal(noticeText(planInfo({ status: "active", ends_at: at(0.2) }), now), "Your plan ends today.");
  // Without the device limit of the next plan there is no "others are paused".
  assert.equal(
    noticeText(planInfo({ status: "trialing", ends_at: at(2), next_plan: "free", devices: { used: 4 } }), now),
    "Your trial ends in 2 days. You'll move to the free plan.",
  );
});

test("no notice outside the 3-day window or without ends_at", () => {
  setLanguage("en");
  assert.equal(noticeText(planInfo({ status: "trialing", ends_at: at(3.5), next_plan: "free" }), now), "");
  assert.equal(noticeText(planInfo({ status: "trialing", ends_at: at(-0.1) }), now), "");
  // expires_at alone is the normal renewal date of every plan, not an ending.
  assert.equal(planInfo({ status: "active", expires_at: at(1) }), null);
  assert.equal(noticeText(planInfo(null, undefined), now), "");
  assert.equal(noticeText(planInfo({ ends_at: "not a date" }), now), "");
});

test("tolerant field shapes: nested next_plan and trial objects, strings for numbers", () => {
  const info = planInfo(null, { trial: { ends_at: at(2) }, next_plan: { code: "free", device_limit: "1", traffic_limit_gb: 10 }, device_count: "2" });
  assert.deepEqual(info, { endsAt: Date.parse(at(2)), trial: true, nextPlan: "free", nextGb: 10, nextDevices: 1, deviceCount: 2 });
  // The session plan wins over /me/entitlement when both have a field.
  assert.equal(planInfo({ ends_at: at(1) }, { ends_at: at(2) }).endsAt, Date.parse(at(1)));
});

test("russian and turkish notices", () => {
  const ent = { status: "trialing", ends_at: at(2), next_plan: "free", next_device_limit: 1, next_traffic_limit_bytes: 10 * 2 ** 30, device_count: 2 };
  setLanguage("ru");
  assert.equal(
    noticeText(planInfo(ent), now),
    "Пробный период заканчивается через 2 дня. Вы перейдёте на бесплатный тариф (10 ГБ в месяц, 1 устройство). Активным останется устройство, которым вы пользовались последним; остальные будут приостановлены.",
  );
  setLanguage("tr");
  assert.equal(
    noticeText(planInfo(ent), now),
    "Deneme süreniz 2 gün içinde bitiyor. Ücretsiz pakete geçeceksiniz (ayda 10 GB, 1 cihaz). En son kullandığınız cihaz etkin kalır, diğerleri duraklatılır.",
  );
  setLanguage("en");
});

test("DEVICE_OVER_LIMIT body is read tolerantly", () => {
  const body = {
    error: { code: "DEVICE_OVER_LIMIT", message: "…" },
    device_limit: 1,
    active_devices: [{ id: "d2", name: "Pixel 8", last_seen_at: "2026-10-06T09:00:00Z" }, null, { id: 5 }],
  };
  assert.deepEqual(pausedInfo(body), {
    limit: 1,
    active: [{ id: "d2", name: "Pixel 8", lastSeenAt: "2026-10-06T09:00:00Z" }, { id: null, name: null, lastSeenAt: null }],
  });
  assert.deepEqual(pausedInfo(null), { limit: null, active: [] });
  assert.deepEqual(pausedInfo({ error: { code: "DEVICE_OVER_LIMIT", device_limit: 2 } }), { limit: 2, active: [] });
});

test("paused text in every language, with and without numbers", () => {
  setLanguage("en");
  assert.equal(pausedText(pausedInfo({ device_limit: 1, active_devices: [{ id: "d2", name: "Pixel 8" }] }), "d1"), "Your plan allows 1 device. Active: Pixel 8.");
  assert.equal(pausedText(pausedInfo({ device_limit: 3, active_devices: [] }), "d1"), "Your plan allows 3 devices.");
  assert.equal(pausedText(pausedInfo({}), "d1"), "Your plan's device limit is reached.");
  // This browser itself is never listed as the active one.
  assert.equal(pausedText(pausedInfo({ device_limit: 1, active_devices: [{ id: "d1", name: "Chrome" }] }), "d1"), "Your plan allows 1 device.");
  setLanguage("ru");
  assert.equal(pausedText(pausedInfo({ device_limit: 1, active_devices: [{ id: "d2", name: "Pixel 8" }] }), "d1"), "Ваш тариф допускает 1 устройство. Активно: Pixel 8.");
  assert.equal(pausedText(pausedInfo({ device_limit: 5 }), "d1"), "Ваш тариф допускает 5 устройств.");
  setLanguage("tr");
  assert.equal(pausedText(pausedInfo({ device_limit: 1, active_devices: [{ id: "d2", name: "Pixel 8" }] }), "d1"), "Paketiniz 1 cihaza izin veriyor. Etkin: Pixel 8.");
  setLanguage("en");
});
