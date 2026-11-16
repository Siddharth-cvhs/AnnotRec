import type { Emitter } from "../emitter";
import type { AppEvents } from "../events";
import type { ClipPort, RecordingSink, SinkSession } from "../ports";
import type { Registry } from "../registry";
import { createStore } from "../store";
import type { Phase } from "../types";
import type { CaptureService } from "./capture";
import type { NotifierService } from "./notifier";
import type { SettingsService } from "./settings";
import type { ViewportService } from "./viewport";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export interface RecordingDeps {
  capture: CaptureService;
  clip: ClipPort;
  viewport: ViewportService;
  settings: SettingsService;
  notifier: NotifierService;
  sinks: Registry<RecordingSink & { id: string }>;
  bus: Emitter<AppEvents>;
}

/**
 * The recording lifecycle: idle -> countdown -> recording <-> paused -> saving -> idle.
 *
 * It knows nothing about drawing: freezing the page never touches it. What it
 * does with a finished recording is up to the chosen sink; what the UI does
 * about it (toasts, the library) hangs off the "recording:saved" event.
 */
export class RecordingService {
  readonly store = createStore<{
    phase: Phase;
    countdown: number | null;
    saveProgress: number | null;
    /** Elapsed time up to the last pause, and since when it runs (null while paused). */
    timer: { base: number; since: number | null };
  }>({ phase: "idle", countdown: null, saveProgress: null, timer: { base: 0, since: null } });

  private cancelFlag = false;
  private session: SinkSession | null = null;

  constructor(private readonly d: RecordingDeps) {
    // "Stop sharing" in the browser's own bar: save what we have.
    d.bus.on("capture:ended", () => {
      this.cancelFlag = true;
      if (d.clip.state !== "inactive") {
        d.notifier.info("Screen sharing stopped. Saving what was recorded…");
        void this.finish();
      } else if (this.phase === "countdown") {
        this.d.viewport.unpin();
        this.setPhase("idle");
        this.store.set({ countdown: null });
      }
    });
  }

  get phase(): Phase {
    return this.store.get().phase;
  }

  get busy(): boolean {
    return this.phase !== "idle";
  }

  level = () => this.d.clip.level();

  private setPhase(phase: Phase) {
    const previous = this.phase;
    if (previous === phase) return;
    this.store.set({ phase });
    this.d.bus.emit("recording:phase", { phase, previous });
  }

  private elapsed(): number {
    const { base, since } = this.store.get().timer;
    return base + (since ? Date.now() - since : 0);
  }

  private pickSink(): RecordingSink {
    const { sinks, settings } = this.d;
    const sink = sinks.get(settings.value.sink) ?? sinks.list()[0];
    if (!sink) throw new Error("No recording destination is set up.");
    return sink;
  }

  async start() {
    const { capture, clip, viewport, settings, notifier, bus } = this.d;
    if (this.phase !== "idle") return;
    try {
      await capture.ensure(); // first await: the click's permission to share is still valid
      viewport.pin();

      const seconds = settings.value.countdown;
      if (seconds > 0) {
        this.cancelFlag = false;
        this.setPhase("countdown");
        for (let i = seconds; i >= 1; i--) {
          this.store.set({ countdown: i });
          await sleep(1000);
          if (this.cancelFlag) {
            this.store.set({ countdown: null });
            this.setPhase("idle");
            viewport.unpin();
            return;
          }
        }
        this.store.set({ countdown: null });
      }
      // Let the countdown overlay leave the screen (and the capture catch up)
      // before the first recorded frame, or it would be in the video.
      await nextFrames();
      await capture.fit(); // the viewport size is final now: capture it pixel for pixel
      await sleep(250);

      const quality = settings.value.quality;
      const session = await this.pickSink().open({ quality });
      this.session = session;
      try {
        await clip.start({
          track: capture.track!,
          micOn: settings.value.micOn,
          quality,
          onPiece: (piece) => session.push(piece),
        });
      } catch (e) {
        session.abort();
        this.session = null;
        throw e;
      }
      if (clip.micIssue) notifier.info(clip.micIssue);
      this.store.set({ timer: { base: 0, since: Date.now() } });
      this.setPhase("recording");
      bus.emit("recording:started");
    } catch (e) {
      // (the phase changes during the awaits above, which TypeScript cannot see)
      if ((this.phase as Phase) === "countdown") this.setPhase("idle");
      this.store.set({ countdown: null });
      viewport.unpin();
      notifier.error(e);
    }
  }

  cancelCountdown() {
    this.cancelFlag = true;
  }

  pause() {
    if (this.phase !== "recording") return;
    this.d.clip.pause();
    this.store.update((s) => ({ timer: { base: s.timer.base + (s.timer.since ? Date.now() - s.timer.since : 0), since: null } }));
    this.setPhase("paused");
  }

  resume() {
    if (this.phase !== "paused") return;
    this.d.clip.resume();
    this.store.update((s) => ({ timer: { ...s.timer, since: Date.now() } }));
    this.setPhase("recording");
  }

  async stop() {
    if (this.phase === "recording" || this.phase === "paused") await this.finish();
  }

  toggleMic() {
    const on = !this.d.settings.value.micOn;
    this.d.clip.setMic(on);
    this.d.settings.patch({ micOn: on });
  }

  private async finish() {
    const { clip, settings, notifier, bus, viewport } = this.d;
    if (clip.state === "inactive") return;
    const durationMs = this.elapsed();
    this.setPhase("saving");
    this.store.set({ saveProgress: 0, timer: { base: 0, since: null } });
    try {
      const whole = await clip.stop();
      const session = this.session;
      this.session = null;
      if (!session) throw new Error("The recording has nowhere to go.");
      const file = await session.finish(whole, {
        durationMs,
        quality: settings.value.quality,
        onProgress: (fraction) => this.store.set({ saveProgress: fraction }),
      });
      bus.emit("recording:saved", { file });
    } catch (e) {
      notifier.error(e);
      bus.emit("recording:failed", { error: (e as Error).message });
    } finally {
      this.setPhase("idle");
      this.store.set({ saveProgress: null });
      viewport.unpin(); // the size was pinned to its pixels for the recording only
    }
  }
}
