import { createStore } from "../store";

/** Which dialog is open. The dialogs themselves are `modals` registered by features. */
export class UiService {
  readonly store = createStore<{ modal: { id: string; props: unknown } | null }>({ modal: null });

  open(id: string, props?: unknown) {
    this.store.set({ modal: { id, props } });
  }

  close() {
    this.store.set({ modal: null });
  }

  toggle(id: string) {
    this.store.get().modal?.id === id ? this.close() : this.open(id);
  }
}
