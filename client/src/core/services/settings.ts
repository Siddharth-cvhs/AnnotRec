import type { KeyValueStore } from "../ports";
import { createStore, type Store } from "../store";
import type { Settings } from "../types";

const KEY = "annotrec.settings.v2";

export const DEFAULT_SETTINGS: Settings = {
  color: "#ef4444",
  width: 4,
  micOn: true,
  countdown: 3,
  quality: "standard",
  address: "",
  sink: "server",
};

function load(kv: KeyValueStore): Settings {
  try {
    const raw = JSON.parse(kv.get(KEY) ?? "{}") as Partial<Settings>;
    const d = DEFAULT_SETTINGS;
    return {
      color: typeof raw.color === "string" ? raw.color : d.color,
      width: typeof raw.width === "number" ? Math.min(16, Math.max(2, raw.width)) : d.width,
      micOn: typeof raw.micOn === "boolean" ? raw.micOn : d.micOn,
      countdown: typeof raw.countdown === "number" && raw.countdown >= 0 && raw.countdown <= 10 ? Math.round(raw.countdown) : d.countdown,
      quality: typeof raw.quality === "string" && raw.quality ? raw.quality : d.quality,
      address: typeof raw.address === "string" ? raw.address : d.address,
      sink: typeof raw.sink === "string" && raw.sink ? raw.sink : d.sink,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The user's settings, remembered in the key-value store (localStorage in the browser). */
export class SettingsService {
  readonly store: Store<Settings>;

  constructor(private readonly kv: KeyValueStore) {
    this.store = createStore(load(kv));
  }

  get value(): Settings {
    return this.store.get();
  }

  patch(patch: Partial<Settings>) {
    this.store.set(patch);
    try {
      this.kv.set(KEY, JSON.stringify(this.store.get()));
    } catch {
      /* storage unavailable (private mode): settings just don't persist */
    }
  }

  /** A private corner of the store for a plugin's own settings. */
  namespace(pluginId: string) {
    const key = (k: string) => `annotrec.plugin.${pluginId}.${k}`;
    return {
      get: <T>(k: string, fallback: T): T => {
        try {
          const raw = this.kv.get(key(k));
          return raw === null ? fallback : (JSON.parse(raw) as T);
        } catch {
          return fallback;
        }
      },
      set: (k: string, value: unknown) => {
        try {
          this.kv.set(key(k), JSON.stringify(value));
        } catch {
          /* ignore */
        }
      },
    };
  }
}
