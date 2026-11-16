import { createStore } from "../store";
import type { Toast } from "../types";

/** Human-readable text for whatever was thrown. */
export function errorMessage(e: unknown): string {
  const err = e as Error | undefined;
  if (err?.name === "NotAllowedError") return "Screen sharing was cancelled.";
  return err?.message || String(e);
}

/** Short messages shown to the user (toasts). Any module can post one. */
export class NotifierService {
  readonly store = createStore<{ toasts: Toast[] }>({ toasts: [] });
  private nextId = 0;

  notify(kind: Toast["kind"], text: string, action?: Toast["action"]) {
    const id = ++this.nextId;
    this.store.update((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }));
    setTimeout(() => this.dismiss(id), kind === "error" ? 9000 : 4500);
  }

  info = (text: string) => this.notify("info", text);
  success = (text: string, action?: Toast["action"]) => this.notify("success", text, action);
  error = (e: unknown) => this.notify("error", errorMessage(e));

  dismiss(id: number) {
    this.store.update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }
}
