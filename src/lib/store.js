// Thin wrapper over extension storage (local: survives restarts).
import { ext } from "./target.js";
import { migrateSplit, SPLIT_MODES } from "./routing.js";

export async function load(keys) {
  return ext.storage.local.get(keys);
}

export async function save(values) {
  return ext.storage.local.set(values);
}

export async function remove(keys) {
  return ext.storage.local.remove(keys);
}

export const DEFAULT_SETTINGS = Object.freeze({
  webrtc: true,
  // Off by default: a direct .ru/.su/.рф request shows those sites (and the
  // ISP) the real IP address; users who need it turn it on in settings.
  ruDirect: false,
  autoConnect: true,
  // Kill switch: when the connection drops by itself (plan ended, signed
  // out, device limit), block browser traffic instead of letting it out
  // directly. Off by default.
  killSwitch: false,
  // Split tunneling: "off", "bypass" (listed sites skip Colitu) or "only"
  // (only listed sites use Colitu); splitList is the user's text.
  split: "off",
  splitList: "",
  language: "auto",
});

export async function settings() {
  const { settings: stored } = await load(["settings"]);
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  // 1.0.0 kept a mode and two site lists; read them as split tunneling.
  if (stored && stored.split === undefined) Object.assign(merged, migrateSplit(stored));
  if (!SPLIT_MODES.includes(merged.split)) merged.split = "off";
  delete merged.mode;
  delete merged.bypass;
  delete merged.only;
  return merged;
}
