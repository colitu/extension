// Popup: renders the state the background owns and sends it commands.
// Everything from the network is inserted with textContent, never as HTML.

import { ext } from "../lib/target.js";
import { t, setLanguage, language, errorText } from "../lib/i18n.js";
import { WEB_BASE, APP_BASE } from "../lib/api.js";

const $ = (id) => document.getElementById(id);
let state = null;
let view = "main";
let busyCount = 0;
let pingRequested = false;

const LINKS = {
  forgot: () => `${APP_BASE}/forgot-password`,
  register: () => `${APP_BASE}/register?utm_source=extension`,
  account: () => `${APP_BASE}/`,
  devices: () => `${APP_BASE}/devices`,
  pricing: () => `${WEB_BASE}/${language()}/pricing?utm_source=extension`,
  help: () => `https://docs.colitu.com/${language()}/browser-extension`,
  privacy: () => `${WEB_BASE}/${language()}/legal/privacy`,
  source: () => "https://github.com/colitu/extension",
  apps: () => `${WEB_BASE}/${language()}/download?utm_source=extension`,
};

const CITY = {
  talinn: { en: "Tallinn", ru: "Таллин", tr: "Tallinn" },
  tallinn: { en: "Tallinn", ru: "Таллин", tr: "Tallinn" },
  "varşova": { en: "Warsaw", ru: "Варшава", tr: "Varşova" },
  moskova: { en: "Moscow", ru: "Москва", tr: "Moskova" },
  riga: { en: "Riga", ru: "Рига", tr: "Riga" },
  frankfurt: { en: "Frankfurt", ru: "Франкфурт", tr: "Frankfurt" },
  paris: { en: "Paris", ru: "Париж", tr: "Paris" },
  coventry: { en: "Coventry", ru: "Ковентри", tr: "Coventry" },
  bursa: { en: "Bursa", ru: "Бурса", tr: "Bursa" },
  helsinki: { en: "Helsinki", ru: "Хельсинки", tr: "Helsinki" },
  stockholm: { en: "Stockholm", ru: "Стокгольм", tr: "Stockholm" },
  londra: { en: "London", ru: "Лондон", tr: "Londra" },
};

const TAGS = {
  streaming: { en: "Streaming", ru: "Стриминг", tr: "Yayın" },
  ai: { en: "AI", ru: "ИИ", tr: "Yapay zekâ" },
  gaming: { en: "Gaming", ru: "Игры", tr: "Oyun" },
  privacy: { en: "Privacy", ru: "Приватность", tr: "Gizlilik" },
  speed: { en: "Speed", ru: "Скорость", tr: "Hız" },
};

// --- messaging ---------------------------------------------------------------

async function send(cmd, extra = {}) {
  busy(true);
  try {
    const res = await ext.runtime.sendMessage({ cmd, ...extra });
    if (!res) throw Object.assign(new Error("no answer"), { code: "ERROR" });
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    state = res.value;
    render();
    return state;
  } finally {
    busy(false);
  }
}

async function run(cmd, extra) {
  try {
    return await send(cmd, extra);
  } catch (err) {
    if (err.code === "EMAIL_NOT_VERIFIED") {
      await refreshQuiet();
      show("verify");
      return null;
    }
    toast(errorText(err.code), true);
    await refreshQuiet();
    return null;
  }
}

async function refreshQuiet() {
  try {
    const res = await ext.runtime.sendMessage({ cmd: "state" });
    if (res && res.ok) {
      state = res.value;
      render();
    }
  } catch {
    // background restarting; the storage listener will catch up
  }
}

function busy(on) {
  busyCount += on ? 1 : -1;
  $("busy").hidden = busyCount <= 0;
}

let toastTimer = 0;
function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (bad ? " bad" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

function open(key) {
  const make = LINKS[key];
  if (make) ext.tabs.create({ url: make() });
}

// --- formatting ---------------------------------------------------------------

function countryName(cc) {
  try {
    return new Intl.DisplayNames([language()], { type: "region" }).of(cc.toUpperCase()) || cc;
  } catch {
    return cc;
  }
}

function cityName(city) {
  const entry = CITY[String(city || "").toLowerCase()];
  return entry ? entry[language()] || entry.en : city || "";
}

function flagSrc(cc) {
  return /^[a-z]{2}$/i.test(cc || "") ? `../flags/${cc.toLowerCase()}.png` : "../icons/mark.png";
}

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function dateText(iso) {
  try {
    return new Intl.DateTimeFormat(language(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function pingClass(ms) {
  if (typeof ms !== "number") return "ping";
  return ms < 120 ? "ping good" : ms < 250 ? "ping mid" : "ping";
}

function pingText(ms) {
  return typeof ms === "number" ? `${ms} ms` : "";
}

// --- rendering ----------------------------------------------------------------

function applyStatic() {
  document.documentElement.lang = language();
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute("aria-label", t(el.dataset.i18nTitle));
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}

function show(name) {
  view = name;
  for (const el of document.querySelectorAll(".view")) el.hidden = el.id !== `view-${name}`;
  if (name === "servers") {
    $("in-search").value = "";
    renderServers();
    $("in-search").focus();
  }
}

function render() {
  if (!state) return;
  setLanguage(state.settings.language);
  applyStatic();
  if (state.link) {
    $("link-code").textContent = state.link.code.replace(/^(.{4})(.{4})$/, "$1-$2");
    show("link");
    return;
  }
  if (!state.signedIn) {
    const needsCode = state.pendingDevice && (view === "verify" || (state.status && state.status.error === "EMAIL_NOT_VERIFIED"));
    show(needsCode ? "verify" : "login");
    const err = state.status && state.status.error;
    if (err && err !== "EMAIL_NOT_VERIFIED") showLoginError(err);
    return;
  }
  if (["login", "link", "verify"].includes(view)) view = "main";
  renderMain();
  renderSettings();
  if (view === "servers") renderServers();
  show(view);
}

let lastLoginError = "";
function showLoginError(code) {
  if (code === lastLoginError) return;
  lastLoginError = code;
  toast(errorText(code), true);
}

function currentServer() {
  const servers = (state.session && state.session.servers) || [];
  const c = state.connection;
  if (c.on && c.current) return servers.find((s) => s.id === c.current.id) || c.current;
  if (c.serverId && c.serverId !== "auto") return servers.find((s) => s.id === c.serverId) || null;
  return null;
}

function renderMain() {
  const c = state.connection;
  const plan = state.session && state.session.plan;
  const chip = $("plan-chip");
  const free = plan && plan.traffic_limit_bytes != null;
  chip.textContent = plan ? (free ? t("planFree") : t("planPremium")) : "—";
  chip.className = "chip" + (plan && !free ? " premium" : "");

  const power = $("btn-power");
  power.classList.toggle("on", c.on);
  power.setAttribute("aria-pressed", String(c.on));
  power.setAttribute("aria-label", c.on ? t("connected") : t("tapToConnect"));
  const title = $("status-title");
  title.textContent = c.on ? t("connected") : t("disconnected");
  title.className = c.on ? "status-on" : "";
  $("status-sub").textContent = c.on ? t("tapToDisconnect") : t("tapToConnect");

  const exit = $("exit-line");
  const ex = state.status && state.status.exit;
  exit.hidden = !c.on;
  exit.replaceChildren();
  if (c.on) {
    const label = document.createElement("span");
    label.textContent = t("exitIp") + " ";
    const value = document.createElement("b");
    if (ex && ex.ip) value.textContent = ex.colitu ? `${ex.ip} · ${ex.country || ""}` : `${ex.ip} · ${t("exitDirect")}`;
    else value.textContent = t("checking");
    exit.append(label, value);
  }

  const s = currentServer();
  const flag = $("current-flag");
  if (s && s.country) {
    flag.src = flagSrc(s.country);
    flag.className = "flag";
    $("current-name").textContent = countryName(s.country);
    $("current-sub").textContent = c.on && c.serverId === "auto" ? `${t("fastest")} · ${cityName(s.city)}`.replace(/ · $/, "") : cityName(s.city) || t("servers");
    const ms = state.pings[s.id];
    $("current-ping").textContent = pingText(ms);
    $("current-ping").className = pingClass(ms);
  } else {
    flag.src = "../icons/on-48.png";
    flag.className = "flag auto";
    $("current-name").textContent = t("fastest");
    $("current-sub").textContent = t("fastestSub");
    $("current-ping").textContent = "";
  }

  const alerts = $("alerts");
  alerts.replaceChildren();
  const alert = (text, bad, linkKey, linkText) => {
    const div = document.createElement("div");
    div.className = "alert" + (bad ? " bad" : "");
    div.textContent = text + (linkKey ? " " : "");
    if (linkKey) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = linkText;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        open(linkKey);
      });
      div.append(a);
    }
    alerts.append(div);
  };
  if (state.blocked) alert(t("controlled"), true);
  const err = state.status && state.status.error;
  if (err === "QUOTA_EXCEEDED" || err === "ENTITLEMENT_INACTIVE" || err === "ENTITLEMENT_EXPIRED") alert(errorText(err), true, "pricing", t("upgrade"));
  else if (err === "DEVICE_LIMIT_REACHED") alert(errorText(err), true, "devices", t("manage"));
  else if (err && err !== "NETWORK") alert(errorText(err), true);
  const pe = state.status && state.status.proxyError;
  // Only failures of the proxy itself: a single site that does not answer
  // also raises proxy errors (ERR_TUNNEL_CONNECTION_FAILED) and is not news.
  if (c.on && pe && Date.now() - pe.at < 60000 && /ERR_PROXY_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID|ERR_PROXY_AUTH/i.test(pe.error)) alert(t("proxyError"), true);

  const foot = $("foot");
  foot.replaceChildren();
  if (plan && plan.traffic_limit_bytes != null) {
    const used = plan.traffic_used_bytes || 0;
    const limit = plan.traffic_limit_bytes;
    const meter = document.createElement("div");
    meter.className = "meter" + (used >= limit ? " full" : "");
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, (used / limit) * 100).toFixed(1)}%`;
    meter.append(fill);
    const row = document.createElement("div");
    row.className = "foot-row";
    const text = document.createElement("span");
    text.textContent = t("traffic", { used: bytes(used), limit: bytes(limit) });
    const up = document.createElement("a");
    up.href = "#";
    up.textContent = t("upgrade");
    up.addEventListener("click", (e) => {
      e.preventDefault();
      open("pricing");
    });
    row.append(text, up);
    foot.append(meter, row);
  }
  const apps = document.createElement("div");
  apps.className = "foot-row";
  const hint = document.createElement("span");
  hint.textContent = t("appsHint");
  const get = document.createElement("a");
  get.href = "#";
  get.textContent = t("getApps");
  get.addEventListener("click", (e) => {
    e.preventDefault();
    open("apps");
  });
  apps.append(hint, get);
  foot.append(apps);
}

function serverButton({ id, cc, title, sub, ms, tags, current }) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  if (current) b.setAttribute("aria-current", "true");
  const img = document.createElement("img");
  img.className = "flag" + (cc ? "" : " auto");
  img.alt = "";
  img.src = cc ? flagSrc(cc) : "../icons/on-48.png";
  const text = document.createElement("span");
  text.className = "server-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = sub;
  text.append(strong, small);
  if (tags && tags.length) {
    const wrap = document.createElement("span");
    wrap.className = "tags";
    for (const tag of tags) {
      const label = TAGS[tag];
      if (!label) continue;
      const el = document.createElement("span");
      el.className = "tag";
      el.textContent = label[language()] || label.en;
      wrap.append(el);
    }
    text.append(wrap);
  }
  const ping = document.createElement("span");
  ping.className = pingClass(ms);
  ping.textContent = pingText(ms);
  b.append(img, text, ping);
  b.addEventListener("click", async () => {
    show("main");
    await run("connect", { serverId: id });
  });
  li.append(b);
  return li;
}

function renderServers() {
  const list = $("server-list");
  list.replaceChildren();
  const servers = [...((state.session && state.session.servers) || [])];
  const q = $("in-search").value.trim().toLocaleLowerCase(language());
  const selected = state.connection.serverId || "auto";
  if (!q) list.append(serverButton({ id: "auto", cc: "", title: t("fastest"), sub: t("fastestSub"), current: selected === "auto" }));
  const rows = servers
    .map((s) => ({ s, name: countryName(s.country), city: cityName(s.city) }))
    .filter((x) => !q || `${x.name} ${x.city} ${x.s.country}`.toLocaleLowerCase(language()).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, language()));
  for (const x of rows) {
    list.append(serverButton({ id: x.s.id, cc: x.s.country, title: x.name, sub: x.city, ms: state.pings[x.s.id], tags: x.s.categories, current: selected === x.s.id }));
  }
  if (!servers.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("noServers");
    list.append(li);
  }
}

function renderSettings() {
  const s = state.settings;
  const plan = state.session && state.session.plan;
  $("acct-email").textContent = state.email || "";
  $("acct-plan").textContent = plan ? `${t("plan")}: ${plan.traffic_limit_bytes != null ? t("planFree") : t("planPremium")}${plan.expires_at ? " · " + t("until", { date: dateText(plan.expires_at) }) : ""}` : errorText((state.status && state.status.error) || "ENTITLEMENT_INACTIVE");
  const meter = $("acct-meter");
  if (plan && plan.traffic_limit_bytes != null) {
    meter.hidden = false;
    meter.firstElementChild.style.width = `${Math.min(100, ((plan.traffic_used_bytes || 0) / plan.traffic_limit_bytes) * 100).toFixed(1)}%`;
    $("acct-traffic").textContent = t("traffic", { used: bytes(plan.traffic_used_bytes || 0), limit: bytes(plan.traffic_limit_bytes) });
  } else {
    meter.hidden = true;
    $("acct-traffic").textContent = plan ? t("unlimited") : "";
  }
  if (document.activeElement && document.activeElement.closest("#view-settings")) return; // do not overwrite while typing
  $("set-webrtc").checked = s.webrtc;
  $("set-ru").checked = s.ruDirect;
  $("set-auto").checked = s.autoConnect;
  $("set-mode-all").checked = s.mode !== "only";
  $("set-mode-only").checked = s.mode === "only";
  $("only-field").hidden = s.mode !== "only";
  $("set-only").value = s.only;
  $("set-bypass").value = s.bypass;
  $("set-language").value = s.language || "auto";
  $("about-version").textContent = t("version", { version: state.version });
  $("incognito-hint").hidden = state.incognito !== false;
}

// --- events --------------------------------------------------------------------

function wire() {
  $("btn-link").addEventListener("click", () => run("link-start"));
  $("btn-link-open").addEventListener("click", () => state && state.link && ext.tabs.create({ url: state.link.url }));
  $("btn-link-cancel").addEventListener("click", () => run("link-cancel"));
  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("in-email").value.trim();
    const password = $("in-password").value;
    if (!email || !password) return;
    lastLoginError = "";
    const ok = await run("login", { email, password });
    if (ok) {
      $("in-password").value = "";
      $("toast").hidden = true;
    }
  });
  $("form-verify").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("in-code").value.trim();
    if (!code) return;
    const ok = await run("verify-code", { code });
    if (ok) {
      $("in-code").value = "";
      show("main");
      render();
    }
  });
  $("btn-verify-send").addEventListener("click", async () => {
    if (await run("verify-send", { locale: language() })) toast(t("verifySent"));
  });
  $("btn-verify-cancel").addEventListener("click", async () => {
    await run("sign-out");
    show("login");
  });
  $("btn-power").addEventListener("click", async () => {
    const on = state.connection.on;
    const power = $("btn-power");
    power.classList.add("busy");
    $("status-title").textContent = on ? t("disconnected") : t("connecting");
    await run(on ? "disconnect" : "connect", { serverId: state.connection.serverId || "auto" });
    power.classList.remove("busy");
  });
  $("btn-servers").addEventListener("click", () => {
    show("servers");
    if (!pingRequested) {
      pingRequested = true;
      ext.runtime.sendMessage({ cmd: "ping" }).then((res) => {
        if (res && res.ok) {
          state = res.value;
          render();
        }
      }, () => {});
    }
  });
  $("btn-settings").addEventListener("click", () => show("settings"));
  for (const b of document.querySelectorAll("[data-back]")) b.addEventListener("click", () => show("main"));
  $("in-search").addEventListener("input", renderServers);
  for (const a of document.querySelectorAll("[data-open]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      open(a.dataset.open);
    });
  }
  const toggle = (id, key) =>
    $(id).addEventListener("change", async () => {
      if (await run("settings", { settings: { [key]: $(id).checked } })) toast(t("saved"));
    });
  toggle("set-webrtc", "webrtc");
  toggle("set-ru", "ruDirect");
  toggle("set-auto", "autoConnect");
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener("change", () => {
      $("only-field").hidden = $("set-mode-only").checked === false;
    });
  }
  $("btn-save-sites").addEventListener("click", async () => {
    const settings = { mode: $("set-mode-only").checked ? "only" : "all", only: $("set-only").value, bypass: $("set-bypass").value };
    $("btn-save-sites").blur();
    if (await run("settings", { settings })) toast(t("saved"));
  });
  $("set-language").addEventListener("change", async () => {
    $("set-language").blur();
    await run("settings", { settings: { language: $("set-language").value } });
  });
  $("btn-signout").addEventListener("click", async () => {
    await run("sign-out");
    view = "login";
    render();
  });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (["auth", "session", "connection", "status", "link", "pings", "settings"].some((k) => k in changes)) refreshQuiet();
  });
}

wire();
setLanguage("auto");
applyStatic();
refreshQuiet().then(() => {
  if (state && state.signedIn && (!state.session || !state.session.plan)) ext.runtime.sendMessage({ cmd: "refresh" }).catch(() => {});
});
