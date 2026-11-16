import type { Emitter } from "../emitter";
import type { AppEvents } from "../events";
import type { ShapeKind, ToolDef } from "../contracts";
import { InkEngine } from "../ink/engine";
import type { Registry } from "../registry";
import { createStore } from "../store";
import type { CaptureService } from "./capture";
import type { NotifierService } from "./notifier";
import type { SettingsService } from "./settings";

export interface AnnotationDeps {
  capture: CaptureService;
  settings: SettingsService;
  notifier: NotifierService;
  tools: Registry<ToolDef>;
  shapes: Registry<ShapeKind>;
  bus: Emitter<AppEvents>;
}

/**
 * Freeze the page and draw on it. Choosing a drawing tool grabs the newest
 * frame (in memory, a few ms), which the UI paints over the live page; the
 * recorder is never touched, so a recording simply shows the frozen page, the
 * ink appearing, and the voice. Going "live" drops the picture and the ink.
 */
export class AnnotationService {
  readonly store = createStore<{ frozen: ImageBitmap | null; tool: string }>({ frozen: null, tool: "live" });
  readonly engine: InkEngine;

  constructor(private readonly d: AnnotationDeps) {
    this.engine = new InkEngine({
      shapes: d.shapes,
      tools: d.tools,
      props: () => ({ tool: this.store.get().tool, color: d.settings.value.color, width: d.settings.value.width }),
    });
    // The share ended: there is nothing left to be frozen over.
    d.bus.on("capture:ended", () => this.goLive());
  }

  get frozen(): boolean {
    return this.store.get().frozen !== null;
  }

  /** Any drawing tool freezes the page first (if it is not frozen yet). "live" goes back to the page. */
  async pickTool(id: string) {
    if (id === "live") return this.goLive();
    const { capture, notifier, bus } = this.d;
    try {
      if (!this.frozen) {
        await capture.ensure();
        this.store.set({ frozen: await capture.frame() });
        // Focus must be on this page (not the iframe) for the shortcuts to work.
        (document.activeElement as HTMLElement | null)?.blur();
        window.focus();
        bus.emit("annotation:frozen");
      }
      this.store.set({ tool: id });
      this.engine.toolChanged(id);
      bus.emit("annotation:tool", { tool: id });
    } catch (e) {
      notifier.error(e);
    }
  }

  /** Remove every drawing, drop the frozen picture and give the page back. */
  goLive() {
    const was = this.frozen;
    this.engine.clear();
    this.store.update((s) => {
      s.frozen?.close(); // a full-size bitmap is several MB: release it straight away
      return { frozen: null, tool: "live" };
    });
    this.engine.toolChanged("live");
    if (was) this.d.bus.emit("annotation:live");
  }
}
