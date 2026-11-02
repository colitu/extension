// The Adaptive Connect engine journal (AC4 phase 4): every automatic decision
// (candidates, features, scores, choice, reason), connection outcomes, ping round
// summaries, servers hidden by the honest list and whitelist checks. A ring of the
// last CAPACITY records. The background keeps a copy in extension storage so it
// survives the service worker being unloaded; it never leaves the device by
// itself (there is no support chat in the extension yet).

export const CAPACITY = 300;
export const DECISION = "decision";
export const OUTCOME = "outcome";
export const PING_ROUND = "ping_round";
export const HIDDEN = "hidden";
export const WHITELIST = "whitelist";
export const KINDS = [DECISION, OUTCOME, PING_ROUND, HIDDEN, WHITELIST];

export function createJournal(capacity = CAPACITY) {
  const ring = new Array(capacity).fill(null);
  let next = 0;
  let count = 0;

  const snapshotData = (data) => {
    if (data === undefined || data === null) return null;
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (err) {
      return { error: err && err.name ? String(err.name) : "Error" };
    }
  };

  return {
    capacity,
    // add: a record with a JSON snapshot of `data` taken now.
    add(kind, data, at = Date.now()) {
      ring[next] = { at: new Date(at).toISOString(), kind: String(kind), data: snapshotData(data) };
      next = (next + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    get count() {
      return count;
    },
    // snapshot: the records, oldest first.
    snapshot() {
      const start = (next - count + capacity) % capacity;
      return Array.from({ length: count }, (_, i) => ring[(start + i) % capacity]);
    },
    toJson(indent) {
      return JSON.stringify(this.snapshot(), null, indent);
    },
    // restore: replaces the content with saved records (oldest first); bad ones are dropped.
    restore(list) {
      ring.fill(null);
      next = 0;
      count = 0;
      if (!Array.isArray(list)) return;
      for (const e of list.slice(-capacity)) {
        if (!e || typeof e !== "object" || typeof e.kind !== "string" || typeof e.at !== "string") continue;
        ring[next] = { at: e.at, kind: e.kind, data: e.data === undefined ? null : e.data };
        next = (next + 1) % capacity;
        count = Math.min(count + 1, capacity);
      }
    },
    clear() {
      ring.fill(null);
      next = 0;
      count = 0;
    },
  };
}
