/** A tiny typed event emitter: the kernel's bus, and anything else that needs one. */
export class Emitter<E extends object> {
  private listeners = new Map<keyof E, Set<(payload: never) => void>>();

  /** Subscribes; returns the unsubscribe function. */
  on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }

  once<K extends keyof E>(event: K, listener: (payload: E[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Calls every listener. A listener that throws never stops the others or the emitter. */
  emit<K extends keyof E>(event: K, ...payload: E[K] extends void ? [] : [E[K]]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as (p: unknown) => void)(payload[0]);
      } catch (e) {
        console.error(`[annotrec] a "${String(event)}" listener failed`, e);
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}
