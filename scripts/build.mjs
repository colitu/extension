// Builds the Chrome and Firefox packages from src/ (no dependencies).
//
//   node scripts/build.mjs            -> dist/chrome, dist/firefox + zips
//   node scripts/build.mjs chrome     -> only one browser
//
// Zips are reproducible: fixed timestamps, sorted entries, so anyone can
// rebuild a store package from a tag and compare checksums.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// --api=<base> is for local testing against a mock; store builds never set it.
const apiArg = process.argv.find((a) => a.startsWith("--api="));
const apiBase = apiArg ? apiArg.slice(6) : "https://api.colitu.com/api/v1";
const distName = apiArg ? "dist-dev" : "dist";
const wanted = targets.length ? targets : ["chrome", "firefox"];

const common = {
  manifest_version: 3,
  name: "__MSG_extName__",
  description: "__MSG_extDescription__",
  default_locale: "en",
  version,
  homepage_url: "https://colitu.com/download/browser",
  icons: { 16: "icons/on-16.png", 32: "icons/on-32.png", 48: "icons/on-48.png", 128: "icons/on-128.png" },
  action: {
    default_title: "Colitu VPN",
    default_popup: "popup/popup.html",
    default_icon: { 16: "icons/off-16.png", 32: "icons/off-32.png", 48: "icons/off-48.png", 128: "icons/off-128.png" },
  },
  host_permissions: ["<all_urls>"],
  incognito: "spanning",
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
};

const manifests = {
  chrome: {
    ...common,
    minimum_chrome_version: "116",
    background: { service_worker: "background.js", type: "module" },
    permissions: ["proxy", "storage", "alarms", "privacy", "webRequest", "webRequestAuthProvider"],
  },
  firefox: {
    ...common,
    background: { scripts: ["background.js"], type: "module" },
    permissions: ["proxy", "storage", "alarms", "privacy"],
    browser_specific_settings: {
      gecko: {
        id: "extension@colitu.com",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity"] },
      },
    },
  },
};

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out;
}

// --- minimal deterministic zip writer ------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function zipDir(dir) {
  return zip(files(dir).map((f) => ({ name: relative(dir, f).split(sep).join("/"), data: readFileSync(f) })));
}

// --- build -----------------------------------------------------------------------

const dist = join(root, distName);
mkdirSync(dist, { recursive: true });
const sums = [];

for (const target of wanted) {
  if (!manifests[target]) throw new Error(`unknown target ${target}`);
  const out = join(dist, target);
  rmSync(out, { recursive: true, force: true });
  cpSync(join(root, "src"), out, { recursive: true });
  writeFileSync(
    join(out, "lib", "target.js"),
    `// Generated by scripts/build.mjs.\nexport const TARGET = ${JSON.stringify(target)};\nexport const ext = globalThis.${target === "firefox" ? "browser" : "chrome"};\nexport const API_BASE = ${JSON.stringify(apiBase)};\n`,
  );
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifests[target], null, 2) + "\n");
  const zipName = `colitu-${target}-${version}.zip`;
  const data = zipDir(out);
  writeFileSync(join(dist, zipName), data);
  sums.push(`${createHash("sha256").update(data).digest("hex")}  ${zipName}`);
  console.log(`built ${zipName} (${(data.length / 1024).toFixed(0)} KB)`);
}

// Source package for the Firefox review (AMO asks for it when code is built).
if (wanted.includes("firefox")) {
  const keep = ["src", "scripts", "tests", "package.json", "README.md", "LICENSE", "NOTICE"];
  const entries = [];
  for (const item of keep) {
    const full = join(root, item);
    if (!existsSync(full)) continue;
    const list = statSync(full).isDirectory() ? files(full) : [full];
    for (const f of list) entries.push({ name: relative(root, f).split(sep).join("/"), data: readFileSync(f) });
  }
  const name = `colitu-extension-${version}-source.zip`;
  const data = zip(entries);
  writeFileSync(join(dist, name), data);
  sums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  console.log(`built ${name}`);
}

writeFileSync(join(dist, "SHA256SUMS"), sums.join("\n") + "\n");
