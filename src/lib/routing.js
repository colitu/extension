// Which requests go through the Colitu proxy and which go direct. The same
// `route` function runs in Firefox (proxy.onRequest) and, serialised into a
// PAC script, in Chrome, so both browsers make exactly the same decision.

export const API_HOSTS = ["api.colitu.com"];

// Keep this function self-contained: it is copied into the PAC script with
// Function.prototype.toString and cannot see anything outside its body.
export function route(rules, rawHost) {
  var host = String(rawHost || "").toLowerCase();
  if (host.charAt(0) === "[") host = host.slice(1, -1);
  if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
  if (!host || host === "localhost") return "direct";
  var isV6 = host.indexOf(":") !== -1;
  if (!isV6 && host.indexOf(".") === -1) return "direct";
  var localSuffixes = [".local", ".localhost", ".lan", ".internal", ".home.arpa", ".intranet"];
  for (var i = 0; i < localSuffixes.length; i++) {
    if (host.slice(-localSuffixes[i].length) === localSuffixes[i]) return "direct";
  }
  if (isV6) {
    if (host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return "direct";
  }
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "direct";
  }
  function listed(list) {
    for (var j = 0; j < list.length; j++) {
      var p = list[j];
      if (host === p || host.slice(-(p.length + 1)) === "." + p) return true;
    }
    return false;
  }
  // The proxies themselves are always reached directly.
  if (listed(rules.servers || [])) return "direct";
  if (listed(rules.bypass || [])) return "direct";
  // The Colitu API: through the proxy, but never stranded when it is down.
  if (listed(rules.api || [])) return "fallback";
  if (rules.ruDirect && (listed(["ru", "su", "xn--p1ai", "xn--p1acf", "xn--d1acj3b"]))) return "direct";
  if (rules.mode === "only") return listed(rules.only || []) ? "proxy" : "direct";
  return "proxy";
}

// normalizeSites turns a user's free-text list into bare domain suffixes.
export function normalizeSites(text) {
  const out = [];
  for (let line of String(text || "").split(/[\s,;]+/)) {
    line = line.trim().toLowerCase();
    if (!line) continue;
    line = line.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
    line = line.replace(/^\*\.?/, "").replace(/^\.+|\.+$/g, "");
    if (!/^[a-z0-9.-]+$/.test(line) && !/^xn--/.test(line)) {
      try {
        line = new URL("http://" + line).hostname;
      } catch {
        continue;
      }
    }
    if (line && line.length <= 253 && !out.includes(line)) out.push(line);
  }
  return out.slice(0, 500);
}

// buildRules collects what `route` needs from settings and the server list.
export function buildRules(settings, servers, serverCountry, apiHosts = API_HOSTS) {
  return {
    servers: [...new Set((servers || []).map((s) => String(s.host).toLowerCase()))],
    bypass: normalizeSites(settings.bypass),
    only: normalizeSites(settings.only),
    mode: settings.mode === "only" ? "only" : "all",
    // Same rule as the apps: Russian sites go direct unless the server
    // itself is in Russia.
    ruDirect: Boolean(settings.ruDirect) && serverCountry !== "RU",
    api: apiHosts,
  };
}

// pacScript renders the rules into a Chrome PAC script. `proxies` is the
// failover chain; there is no DIRECT at the end, so a dead proxy never leaks
// traffic around it.
export function pacScript(rules, proxies) {
  const chain = proxies.map((p) => `HTTPS ${p.host}:${p.port}`).join("; ");
  return [
    "var RULES = " + JSON.stringify(rules) + ";",
    "var CHAIN = " + JSON.stringify(chain) + ";",
    "var route = " + route.toString() + ";",
    "function FindProxyForURL(url, host) {",
    "  var r = route(RULES, host);",
    "  if (r === 'direct') return 'DIRECT';",
    "  if (r === 'fallback') return CHAIN + '; DIRECT';",
    "  return CHAIN;",
    "}",
  ].join("\n");
}
