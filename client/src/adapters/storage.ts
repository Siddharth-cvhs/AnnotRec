import type { KeyValueStore } from "../core/ports";

/** localStorage, which can be missing or throw (private mode, blocked site data): never let that break the app. */
export const localStorageKV: KeyValueStore = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

/** An in-memory store (tests, or hosts that do not want anything persisted). */
export function memoryKV(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}
