// Applies the proxy configuration. Chrome takes a PAC script through
// chrome.proxy.settings; Firefox asks us per request through
// proxy.onRequest (see background.js), using the same rules.

import { ext, TARGET } from "./target.js";
import { BLOCK_PROXY, blockPacScript, blockRules, pacScript, route } from "./routing.js";

let active = null; // { rules, chain: [{host, port}], ticket }
let blocking = null; // { rules }: kill switch engaged, nothing but local/API traffic leaves

export function current() {
  return active;
}

export function setTicket(ticket) {
  if (active) active.ticket = ticket;
}

export function isBlocking() {
  return blocking !== null;
}

// rememberBlock restores the in-memory block state (Firefox asks per request;
// the worker may have restarted).
export function rememberBlock(apiHosts) {
  active = null;
  blocking = { rules: blockRules(apiHosts) };
}

export function remember(rules, chain, ticket) {
  blocking = null;
  active = rules && chain && chain.length ? { rules, chain, ticket } : null;
}

export async function apply(rules, chain, ticket) {
  remember(rules, chain, ticket);
  if (TARGET !== "chrome") return;
  await setPac(pacScript(rules, chain));
}

async function setPac(data) {
  const value = { mode: "pac_script", pacScript: { data, mandatory: true } };
  await ext.proxy.settings.set({ value, scope: "regular" });
  if (await ext.extension.isAllowedIncognitoAccess()) {
    await ext.proxy.settings.set({ value, scope: "incognito_persistent" }).catch(() => {});
  }
}

// block engages the kill switch: a PAC script that sends everything except
// local addresses and the Colitu API to a proxy that never answers.
export async function block(apiHosts) {
  rememberBlock(apiHosts);
  if (TARGET !== "chrome") return;
  await setPac(blockPacScript(apiHosts));
}

export async function clear() {
  active = null;
  blocking = null;
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

// unreachable is a proxy nothing listens on: a request sent there fails
// instead of falling back to a direct connection.
export function unreachable() {
  return [{ type: "http", host: BLOCK_PROXY.host, port: BLOCK_PROXY.port, failoverTimeout: 1 }];
}

// safeDecision is what proxy.onRequest runs: any error closes the door
// (unreachable proxy) instead of letting Firefox connect directly.
export function safeDecision(url) {
  try {
    return firefoxDecision(url);
  } catch {
    return unreachable();
  }
}

// firefoxDecision answers proxy.onRequest.
export function firefoxDecision(url) {
  if (blocking) {
    let blockedHost = "";
    try {
      blockedHost = new URL(url).hostname;
    } catch {
      return unreachable();
    }
    return route(blocking.rules, blockedHost) === "direct" ? { type: "direct" } : unreachable();
  }
  if (!active) return { type: "direct" };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return unreachable();
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
