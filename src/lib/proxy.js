// Applies the proxy configuration. Chrome takes a PAC script through
// chrome.proxy.settings; Firefox asks us per request through
// proxy.onRequest (see background.js), using the same rules.

import { ext, TARGET } from "./target.js";
import { pacScript, route } from "./routing.js";

let active = null; // { rules, chain: [{host, port}], ticket }

export function current() {
  return active;
}

export function setTicket(ticket) {
  if (active) active.ticket = ticket;
}

export function remember(rules, chain, ticket) {
  active = rules && chain && chain.length ? { rules, chain, ticket } : null;
}

export async function apply(rules, chain, ticket) {
  remember(rules, chain, ticket);
  if (TARGET !== "chrome") return;
  const value = { mode: "pac_script", pacScript: { data: pacScript(rules, chain), mandatory: true } };
  await ext.proxy.settings.set({ value, scope: "regular" });
  if (await ext.extension.isAllowedIncognitoAccess()) {
    await ext.proxy.settings.set({ value, scope: "incognito_persistent" }).catch(() => {});
  }
}

export async function clear() {
  active = null;
  if (TARGET !== "chrome") return;
  await ext.proxy.settings.clear({ scope: "regular" }).catch(() => {});
  await ext.proxy.settings.clear({ scope: "incognito_persistent" }).catch(() => {});
}

// controlledByOther is true when another extension owns the browser proxy
// setting (Chrome lets only one extension control it).
export async function controlledByOther() {
  if (TARGET !== "chrome") return false;
  try {
    const s = await ext.proxy.settings.get({});
    return s.levelOfControl === "controlled_by_other_extensions" || s.levelOfControl === "not_controllable";
  } catch {
    return false;
  }
}

// firefoxDecision answers proxy.onRequest.
export function firefoxDecision(url) {
  if (!active) return { type: "direct" };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return { type: "direct" };
  }
  const r = route(active.rules, host);
  if (r === "direct") return { type: "direct" };
  const header = "Basic " + btoa("colitu:" + (active.ticket || ""));
  const chain = active.chain.map((p) => ({ type: "https", host: p.host, port: p.port, proxyAuthorizationHeader: header, failoverTimeout: 5 }));
  if (r === "fallback") chain.push({ type: "direct" });
  return chain;
}

// WebRTC can reveal the real address around a proxy; while connected it may
// only use the proxied path.
export async function setWebRTC(protect) {
  const policy = ext.privacy && ext.privacy.network && ext.privacy.network.webRTCIPHandlingPolicy;
  if (!policy) return;
  try {
    if (protect) await policy.set({ value: "disable_non_proxied_udp" });
    else await policy.clear({});
  } catch {
    // Another extension or a policy owns the setting.
  }
}
