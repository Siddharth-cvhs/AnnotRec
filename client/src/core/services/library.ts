import type { LibraryPort } from "../ports";
import { createStore } from "../store";
import type { FileInfo } from "../types";
import type { NotifierService } from "./notifier";

/** The saved recordings and screenshots. */
export class LibraryService {
  readonly store = createStore<{ files: FileInfo[] }>({ files: [] });

  constructor(
    private readonly port: LibraryPort,
    private readonly notifier: NotifierService,
  ) {}

  async refresh() {
    try {
      this.store.set({ files: await this.port.list() });
    } catch {
      /* the server may be restarting: keep what we have */
    }
  }

  async remove(name: string) {
    try {
      await this.port.remove(name);
      await this.refresh();
    } catch (e) {
      this.notifier.error(e);
    }
  }

  async reveal(name: string) {
    try {
      await this.port.reveal(name);
    } catch (e) {
      this.notifier.error(e);
    }
  }

  url = (name: string, download = false) => this.port.url(name, download);

  saveImage(blob: Blob) {
    return this.port.saveImage(blob);
  }
}
