// Thin wrapper over extension storage (local: survives restarts).
import { ext } from "./target.js";

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
  ruDirect: true,
  autoConnect: true,
  mode: "all",
  bypass: "",
  only: "",
  language: "auto",
});

export async function settings() {
  const { settings: stored } = await load(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}
