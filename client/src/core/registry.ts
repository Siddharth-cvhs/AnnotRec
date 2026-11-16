export interface Entry {
  id: string;
  /** Lower comes first. Entries without one keep their registration order, after those with one. */
  order?: number;
}

/**
 * A set of things features contribute: commands, tools, panels, shapes...
 * Adding an entry with an existing id replaces it (a plugin can override a
 * built-in); the disposer removes it again.
 */
export class Registry<T extends Entry> {
  private items = new Map<string, T>();
  private listeners = new Set<() => void>();
  private addListeners = new Set<(item: T) => void>();
  private cache: readonly T[] | null = null;

  add(item: T): () => void {
    this.items.set(item.id, item);
    this.changed();
    for (const l of [...this.addListeners]) l(item);
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id);
        this.changed();
      }
    };
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Sorted by `order`. The same array instance is returned until something changes. */
  list = (): readonly T[] => {
    if (!this.cache) {
      this.cache = [...this.items.values()]
        .map((item, i) => ({ item, i }))
        .sort((a, b) => (a.item.order ?? 1e9) - (b.item.order ?? 1e9) || a.i - b.i)
        .map((x) => x.item);
    }
    return this.cache;
  };

  /** Runs for every entry now and every entry added later. */
  onAdd(listener: (item: T) => void): () => void {
    for (const item of this.items.values()) listener(item);
    this.addListeners.add(listener);
    return () => this.addListeners.delete(listener);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() {
    this.cache = null;
    for (const l of [...this.listeners]) l();
  }
}
