/**
 * A minimal observable store: the state of one service. React reads it with
 * `useStore` (useSyncExternalStore); anything else can `subscribe`.
 */
export interface Store<T> {
  get(): T;
  /** Merges `patch`; subscribers run only if a value actually changed. */
  set(patch: Partial<T>): void;
  update(fn: (state: T) => Partial<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => state,
    set(patch) {
      const keys = Object.keys(patch) as (keyof T)[];
      if (keys.every((k) => Object.is(state[k], patch[k]))) return;
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    update(fn) {
      store.set(fn(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}
