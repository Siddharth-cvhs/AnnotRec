import type { Emitter } from "../emitter";
import type { AppEvents } from "../events";
import type { CapturePort } from "../ports";
import { createStore } from "../store";

/**
 * The shared "share this tab" session. One permission serves every recording
 * and every freeze. Owns nothing browser-specific: that is the CapturePort.
 */
export class CaptureService {
  readonly store = createStore({ active: false });

  constructor(
    private readonly port: CapturePort,
    /** The element to record; supplied by the viewport. */
    private readonly getElement: () => HTMLElement | null,
    private readonly bus: Emitter<AppEvents>,
  ) {
    port.onEnded(() => {
      this.store.set({ active: false });
      bus.emit("capture:ended");
    });
  }

  get supported() {
    return this.port.supported;
  }

  get track() {
    return this.port.track;
  }

  /** Starts sharing if it is not already (asks the user the first time). */
  async ensure() {
    if (this.port.active) return;
    const el = this.getElement();
    if (!el) throw new Error("The viewport is not ready.");
    await this.port.start(el);
    this.store.set({ active: true });
    this.bus.emit("capture:started");
  }

  fit = () => this.port.fit();
  frame = () => this.port.frame();
  toPng = (frame: ImageBitmap) => this.port.toPng(frame);

  /** For tests: behave as if the user pressed the browser's "Stop sharing". */
  simulateEnd() {
    this.port.simulateEnd?.();
  }
}
