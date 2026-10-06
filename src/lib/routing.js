// Which requests go through the Colitu proxy and which go direct. The same
// `route` function runs in Firefox (proxy.onRequest) and, serialised into a
// PAC script, in Chrome, so both browsers make exactly the same decision.

export const API_HOSTS = ["api.colitu.com"];

// Split tunneling modes: off, "bypass" (listed sites never use Colitu) and
// "only" (only listed sites use Colitu).
export const SPLIT_MODES = ["off", "bypass", "only"];
export const SPLIT_MAX = 500;

// ip4, ip6 and route are copied into the PAC script with
// Function.prototype.toString: they may only use each other and nothing else
// from this module, and must stay plain ES5.

// ip4 parses a dotted IPv4 address into a number, or returns null.
export function ip4(text) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text));
  if (!m) return null;
  var n = 0;
  for (var k = 1; k <= 4; k++) {
    var o = +m[k];
    if (o > 255 || (m[k].length > 1 && m[k].charAt(0) === "0")) return null;
    n = n * 256 + o;
  }
  return n;
}

// ip6 parses an IPv6 address (with "::" and an optional IPv4 tail) into
// eight 16-bit numbers, or returns null.
export function ip6(text) {
  var z = String(text).toLowerCase();
  if (z.indexOf(":") === -1) return null;
  var dbl = z.indexOf("::");
  if (dbl !== -1 && z.indexOf("::", dbl + 1) !== -1) return null;
  var head = dbl === -1 ? z.split(":") : z.slice(0, dbl) ? z.slice(0, dbl).split(":") : [];
  var tail = dbl === -1 ? [] : z.slice(dbl + 2) ? z.slice(dbl + 2).split(":") : [];
  var last = dbl === -1 ? head : tail;
  if (last.length && last[last.length - 1].indexOf(".") !== -1) {
    var v4 = ip4(last.pop());
    if (v4 === null) return null;
    last.push(Math.floor(v4 / 65536).toString(16), (v4 % 65536).toString(16));
  }
  var fill = 8 - head.length - tail.length;
  if (dbl !== -1 && fill < 1) return null;
  var groups = head.slice();
  for (var f = 0; dbl !== -1 && f < fill; f++) groups.push("0");
  groups = groups.concat(tail);
  if (groups.length !== 8) return null;
  var out = [];
  for (var g = 0; g < 8; g++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[g])) return null;
    out.push(parseInt(groups[g], 16));
  }
  return out;
}

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
  // IP and CIDR rules match sites opened by address. Host names are not
  // resolved here: a DNS lookup would leave the browser outside the proxy.
  var a4 = isV6 ? null : ip4(host);
  var a6 = isV6 ? ip6(host) : null;
  function inNets(nets) {
    if (!nets || (a4 === null && !a6)) return false;
    for (var j = 0; j < nets.length; j++) {
      var n = nets[j];
      var bits = n[2];
      if (n[0] === 4 && a4 !== null) {
        var d = Math.pow(2, 32 - bits);
        if (Math.floor(a4 / d) === Math.floor(n[1] / d)) return true;
      } else if (n[0] === 6 && a6) {
        var same = true;
        for (var g = 0; g < 8 && same; g++) {
          var b = Math.min(16, Math.max(0, bits - g * 16));
          if (b === 0) break;
          var q = Math.pow(2, 16 - b);
          same = Math.floor(a6[g] / q) === Math.floor(n[1][g] / q);
        }
        if (same) return true;
      }
    }
    return false;
  }
  // The proxies themselves are always reached directly.
  if (listed(rules.servers || [])) return "direct";
  // Split tunneling, "selected sites bypass Colitu".
  if (listed(rules.bypass || []) || inNets(rules.bypassNets)) return "direct";
  // The Colitu API: through the proxy, but never stranded when it is down.
  if (listed(rules.api || [])) return "fallback";
  // Split tunneling, "only selected sites use Colitu": the user's list wins
  // over "Russian sites directly".
  if (rules.mode === "only") return listed(rules.only || []) || inNets(rules.onlyNets) ? "proxy" : "direct";
  if (rules.ruDirect && (listed(["ru", "su", "xn--p1ai", "xn--p1acf", "xn--d1acj3b"]))) return "direct";
  return "proxy";
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function fmt6(groups) {
  // RFC 5952: the longest run of two or more zero groups becomes "::".
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > len && j - i >= 2) [best, len] = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best === -1) return hex.join(":");
  return hex.slice(0, best).join(":") + "::" + hex.slice(best + len).join(":");
}

// parseNet reads "203.0.113.7", "203.0.113.0/24", "2001:db8::1",
// "[2001:db8::1]" or "2001:db8::/32" into [4|6, address, prefix] with the
// host bits cleared, or returns null.
export function parseNet(text) {
  const m = /^\[?([0-9a-f:.]+)\]?(?:\/(\d{1,3}))?$/i.exec(String(text).trim());
  if (!m) return null;
  const a4 = ip4(m[1]);
  const a6 = a4 === null ? ip6(m[1]) : null;
  if (a4 === null && !a6) return null;
  const max = a4 !== null ? 32 : 128;
  const bits = m[2] === undefined ? max : Number(m[2]);
  if (!(bits >= 0 && bits <= max)) return null;
  if (a4 !== null) {
    const d = 2 ** (32 - bits);
    return [4, Math.floor(a4 / d) * d, bits];
  }
  const base = a6.map((g, i) => {
    const b = Math.min(16, Math.max(0, bits - i * 16));
    const q = 2 ** (16 - b);
    return Math.floor(g / q) * q;
  });
  return [6, base, bits];
}

export function formatNet(net) {
  const addr = net[0] === 4 ? [24, 16, 8, 0].map((s) => Math.floor(net[1] / 2 ** s) % 256).join(".") : fmt6(net[1]);
  return net[2] === (net[0] === 4 ? 32 : 128) ? addr : `${addr}/${net[2]}`;
}

function domain(token) {
  let line = token.toLowerCase();
  line = line.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  line = line.replace(/^\*\.?/, "").replace(/^\.+|\.+$/g, "");
  if (!line) return null;
  if (!/^[a-z0-9.-]+$/.test(line)) {
    try {
      line = new URL("http://" + line).hostname;
    } catch {
      return null;
    }
  }
  if (line.length > 253 || !line.split(".").every((l) => LABEL.test(l))) return null;
  // Only digits and dots is a broken address ("1.2.3", "999.1.1.1"), not a site.
  if (/^[0-9.]+$/.test(line)) return null;
  return line;
}

// hostPart strips a scheme, port and path from an address entry, keeping a
// CIDR suffix: "http://203.0.113.7:8080/x" -> "203.0.113.7", "[::1]:80" -> "::1".
function hostPart(token) {
  const bare = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (bare.startsWith("[")) {
    const close = bare.indexOf("]");
    if (close === -1) return bare;
    const rest = bare.slice(close + 1);
    const prefix = /^\/\d{1,3}$/.test(rest) ? rest : "";
    return bare.slice(1, close) + prefix;
  }
  if (/^[^/?#]+\/\d{1,3}$/.test(bare)) return bare; // a CIDR range
  return bare.replace(/[/?#].*$/, "").replace(/^([0-9.]+):\d+$/, "$1");
}

// parseSplitList validates the user's split-tunneling list: domains (suffix
// match: "example.com" covers "www.example.com"), IPv4/IPv6 addresses and
// CIDR ranges. One entry per line (commas and spaces also separate).
export function parseSplitList(text) {
  const sites = [];
  const nets = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (sites.length + nets.length >= SPLIT_MAX) break;
    const net = parseNet(hostPart(token));
    if (net) {
      const key = formatNet(net);
      if (!seen.has(key)) {
        nets.push(net);
        seen.add(key);
      }
      continue;
    }
    const d = domain(token);
    if (d) {
      if (!seen.has(d)) {
        sites.push(d);
        seen.add(d);
      }
    } else if (invalid.length < 20 && !invalid.includes(token)) {
      invalid.push(token.slice(0, 80));
    }
  }
  return { sites, nets, invalid, entries: [...sites, ...nets.map(formatNet)] };
}

// normalizeSites keeps the domain part of a list.
export function normalizeSites(text) {
  return parseSplitList(text).sites;
}

// migrateSplit turns the 1.0.0 site settings (mode all/only, a bypass list and
// an only list) into the split-tunneling setting.
export function migrateSplit(old = {}) {
  if (old.mode === "only" && String(old.only || "").trim()) return { split: "only", splitList: String(old.only) };
  if (String(old.bypass || "").trim()) return { split: "bypass", splitList: String(old.bypass) };
  return { split: "off", splitList: "" };
}

// splitSettings returns the effective mode and the parsed list. "Only" with an
// empty list would send nothing through Colitu; it counts as off.
export function splitSettings(settings = {}) {
  const s = settings.split === undefined ? migrateSplit(settings) : settings;
  const chosen = SPLIT_MODES.includes(s.split) ? s.split : "off";
  const list = parseSplitList(chosen === "off" ? "" : s.splitList);
  const count = list.sites.length + list.nets.length;
  return { mode: count ? chosen : "off", count, list };
}

// buildRules collects what `route` needs from settings and the server list.
export function buildRules(settings, servers, serverCountry, apiHosts = API_HOSTS) {
  const split = splitSettings(settings);
  return {
    servers: [...new Set((servers || []).map((s) => String(s.host).toLowerCase()))],
    bypass: split.mode === "bypass" ? split.list.sites : [],
    bypassNets: split.mode === "bypass" ? split.list.nets : [],
    only: split.mode === "only" ? split.list.sites : [],
    onlyNets: split.mode === "only" ? split.list.nets : [],
    mode: split.mode === "only" ? "only" : "all",
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
    "var ip4 = " + ip4.toString() + ";",
    "var ip6 = " + ip6.toString() + ";",
    "var route = " + route.toString() + ";",
    "function FindProxyForURL(url, host) {",
    "  var r = route(RULES, host);",
    "  if (r === 'direct') return 'DIRECT';",
    "  if (r === 'fallback') return CHAIN + '; DIRECT';",
    "  return CHAIN;",
    "}",
  ].join("\n");
}
