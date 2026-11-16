import type { BackendPort } from "../ports";
import { createStore } from "../store";
import type { NotifierService } from "./notifier";

/** What the server can do (FFmpeg present? which qualities?). */
export class BackendService {
  readonly store = createStore({ ready: false, ffmpeg: true, qualities: ["standard", "high"] as string[] });

  constructor(
    private readonly port: BackendPort,
    private readonly notifier: NotifierService,
  ) {}

  async init() {
    try {
      const h = await this.port.health();
      this.store.set({ ready: true, ffmpeg: h.ffmpeg, qualities: h.qualities });
    } catch (e) {
      this.notifier.error(new Error(`Cannot reach the AnnotRec server: ${(e as Error).message}`));
    }
  }
}
