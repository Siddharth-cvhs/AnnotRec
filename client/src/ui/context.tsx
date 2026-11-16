import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Kernel } from "../core/kernel";
import type { Entry, Registry } from "../core/registry";
import type { Store } from "../core/store";

const KernelContext = createContext<Kernel | null>(null);

export function KernelProvider({ kernel, children }: { kernel: Kernel; children: ReactNode }) {
  return <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>;
}

/** The kernel the surrounding <AnnotRec> was built with. */
export function useKernel(): Kernel {
  const k = useContext(KernelContext);
  if (!k) throw new Error("useKernel must be used inside <AnnotRec>.");
  return k;
}

/** Read a service's store; re-renders when it changes. Pass a selector to react to part of it only. */
export function useStore<T extends object>(store: Store<T>): T;
export function useStore<T extends object, S>(store: Store<T>, select: (state: T) => S): S;
export function useStore<T extends object, S>(store: Store<T>, select?: (state: T) => S): T | S {
  return useSyncExternalStore(
    store.subscribe,
    () => (select ? select(store.get()) : store.get()),
    () => (select ? select(store.get()) : store.get()),
  );
}

/** The entries of a registry (sorted); re-renders when entries are added or removed. */
export function useRegistry<T extends Entry>(registry: Registry<T>): readonly T[] {
  return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
}

/** Memoise something per kernel (a service handle, a bound command...). */
export function useKernelMemo<T>(factory: (k: Kernel) => T): T {
  const k = useKernel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => factory(k), [k]);
}
