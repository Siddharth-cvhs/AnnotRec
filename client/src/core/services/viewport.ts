import type { Emitter } from "../emitter";
import type { AppEvents } from "../events";
import type { ViewportPort } from "../ports";
import { createStore } from "../store";
import type { SizeMode } from "../types";
import type { NotifierService } from "./notifier";
import type { SettingsService } from "./settings";

/** The page being shown and recorded: its address, size and the element it lives in. */
export class ViewportService {
  readonly store = createStore<{
    address: string;
    /** What the iframe loads; null until the server has been told the target. */
    src: string | null;
    reloadKey: number;
    sizeMode: SizeMode;
    /** Actual size on screen in CSS pixels. */
    measured: { w: number; h: number };
  }>({ address: "", src: null, reloadKey: 0, sizeMode: { kind: "fit" }, measured: { w: 0, h: 0 } });

  /** The recorded element (set by the UI). */
  element: HTMLElement | null = null;
  private pinned = false;

  constructor(
    private readonly port: ViewportPort,
    private readonly settings: SettingsService,
    private readonly notifier: NotifierService,
    private readonly bus: Emitter<AppEvents>,
  ) {
    this.store.set({ address: settings.value.address });
  }

  /**
   * The server remembers one target page, and other tabs or a restart may
   * have changed it: always point it at what this page shows.
   */
  async init() {
    const sample = this.port.sampleUrl();
    try {
      let shown: { viewportUrl: string };
      try {
        shown = await this.port.setTarget(this.settings.value.address || sample);
      } catch {
        shown = await this.port.setTarget(sample); // the saved address is no longer valid
      }
      this.store.set({ src: shown.viewportUrl });
    } catch (e) {
      this.notifier.error(new Error(`Cannot reach the AnnotRec server: ${(e as Error).message}`));
    }
  }

  async go(address: string) {
    try {
      const r = await this.port.setTarget(address);
      this.settings.patch({ address });
      this.store.update((s) => ({ address, src: r.viewportUrl, reloadKey: s.reloadKey + 1 }));
      this.bus.emit("viewport:navigated", { address, url: r.viewportUrl });
    } catch (e) {
      this.notifier.error(e);
    }
  }

  reload() {
    this.store.update((s) => ({ reloadKey: s.reloadKey + 1 }));
  }

  setSizeMode(sizeMode: SizeMode) {
    this.store.set({ sizeMode });
  }

  setMeasured(measured: { w: number; h: number }) {
    const m = this.store.get().measured;
    if (m.w !== measured.w || m.h !== measured.h) this.store.set({ measured });
  }

  /** Freeze "fit to window" at its current pixel size: it must not change mid-recording. */
  pin() {
    const { sizeMode, measured } = this.store.get();
    this.pinned = sizeMode.kind === "fit" && measured.w > 0;
    if (this.pinned) this.store.set({ sizeMode: { kind: "fixed", w: measured.w, h: measured.h } });
  }

  /** Undo `pin` (the size was only pinned for the recording). */
  unpin() {
    if (!this.pinned) return;
    this.pinned = false;
    this.store.set({ sizeMode: { kind: "fit" } });
  }
}
