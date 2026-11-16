// Capturing the viewport in the browser.
//
// Tab capture (getDisplayMedia on the current tab) records the page exactly as
// it is on screen: the proxied iframe, the frozen picture and the ink on top
// of it. Region Capture (CropTarget / cropTo) then cuts the stream down to the
// viewport element, so the toolbar and the rest of the page are never in it.
// The same cropped stream feeds the MediaRecorder and the freeze snapshots.
//
// This file is the browser adapter for the CapturePort and ClipPort (core/ports.ts).

import type { CapturePort, ClipPort } from "../core/ports";
import type { Quality } from "../core/types";

declare const CropTarget: { fromElement(el: Element): Promise<unknown> } | undefined;

type CroppableTrack = MediaStreamTrack & { cropTo(target: unknown): Promise<void> };

function captureSupported(): boolean {
  return (
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof CropTarget !== "undefined" &&
    typeof MediaRecorder !== "undefined"
  );
}

export class NoPictureError extends Error {
  constructor() {
    super("The browser did not start sharing the picture. Keep this tab in front and try again.");
    this.name = "NoPictureError";
  }
}

/** One screen-share permission, reused for snapshots and any number of recordings. */
export class BrowserCapture implements CapturePort {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private element: HTMLElement | null = null;
  private endedListeners = new Set<() => void>();

  get supported(): boolean {
    return captureSupported();
  }

  get active(): boolean {
    return this.stream !== null;
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  onEnded(listener: () => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  private emitEnded() {
    for (const l of [...this.endedListeners]) l();
  }

  /**
   * Asks the browser to share this tab, cropped to `element`. Needs a user
   * gesture. Tab capture occasionally starts without ever delivering a frame
   * (seen on cold starts), which would leave Start looking dead: so the first
   * frame is awaited, and the capture is retried once before giving up.
   */
  async start(element: HTMLElement): Promise<void> {
    if (this.stream) return;
    this.element = element;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (await this.open(element, attempt === 1 ? 3000 : 6000)) return;
      // No frame arrived. A second prompt needs a fresh click: only retry
      // while the click that started us still counts (Chromium keeps it ~5 s).
      if (attempt === 1 && navigator.userActivation && !navigator.userActivation.isActive) break;
    }
    throw new NoPictureError();
  }

  /** One capture attempt: true once frames are flowing. */
  private async open(element: HTMLElement, waitMs: number): Promise<boolean> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
      // Chromium hints: offer only this tab, no switching to other surfaces.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
    const [track] = stream.getVideoTracks();
    try {
      const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
      if (surface && surface !== "browser") {
        throw new Error('Please choose "This tab" (not a window or screen) when asked what to share.');
      }
      await (track as CroppableTrack).cropTo(await CropTarget!.fromElement(element));
      await this.fitTrack(track, element);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Kept in the page (decoders sleep for detached videos) but invisible, and
    // outside the viewport element so it is never captured.
    Object.assign(video.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "2px",
      height: "2px",
      opacity: "0.01",
      pointerEvents: "none",
    });
    document.body.appendChild(video);
    void video.play().catch(() => {});

    if (!(await this.firstFrame(video, element, waitMs))) {
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      return false;
    }
    track.addEventListener("ended", () => {
      this.release();
      this.emitEnded();
    });
    this.stream = stream;
    this.video = video;
    return true;
  }

  /** Resolves true when the video shows a frame, false after `waitMs`. */
  private firstFrame(video: HTMLVideoElement, element: HTMLElement, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearInterval(nudge);
        resolve(ok);
      };
      // A tiny repaint now and then, in case the page is perfectly still.
      const nudge = window.setInterval(() => {
        element.style.opacity = "0.999";
        requestAnimationFrame(() => requestAnimationFrame(() => (element.style.opacity = "")));
      }, 250);
      video.requestVideoFrameCallback(() => finish(true));
      setTimeout(() => finish(video.videoWidth > 0), waitMs);
    });
  }

  /**
   * Makes the captured picture exactly as many pixels as the viewport has on
   * screen. Left alone, the browser scales the cropped region to fit a frame
   * sized by the whole tab: about 25% bigger than the viewport (soft, and
   * larger files) or, with a plain maximum, smaller. Exact sizes give 1:1.
   */
  private async fitTrack(track: MediaStreamTrack, element: HTMLElement) {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(element.clientWidth * dpr);
    const height = Math.round(element.clientHeight * dpr);
    if (width < 2 || height < 2) return;
    try {
      await track.applyConstraints({ width: { exact: width }, height: { exact: height } });
    } catch {
      /* the browser keeps its own size: still a valid recording */
    }
  }

  /** Re-fits the picture to the viewport; call when the viewport size is final (recording start). */
  async fit(): Promise<void> {
    if (this.track && this.element) await this.fitTrack(this.track, this.element);
  }

  /**
   * The picture of the viewport right now, as an in-memory bitmap: the video
   * always holds the newest frame, so this takes a few milliseconds (no waiting
   * for frames, no PNG encoding). Used to freeze the page.
   */
  async frame(): Promise<ImageBitmap> {
    const video = this.video;
    if (!video) throw new Error("Screen sharing is not active.");
    if (video.videoWidth === 0 || video.readyState < 2) throw new NoPictureError();
    return createImageBitmap(video);
  }

  /** A PNG of a frame (screenshots). */
  async toPng(bitmap: ImageBitmap): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Cannot read the picture."))), "image/png"),
    );
  }

  /** What the browser's "Stop sharing" button does: end the session. For tests. */
  simulateEnd() {
    this.release();
    this.emitEnded();
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.stream = null;
    this.video = null;
  }
}

function pickMime(): string {
  const options = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

/** Source bitrate per quality; FFmpeg re-encodes it, so this only needs to keep the picture clean. */
const BITRATE: Record<string, number> = { standard: 6_000_000, high: 12_000_000 };

/** Records the viewport stream plus the microphone into a WebM blob. */
export class BrowserClip implements ClipPort {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mic: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Uint8Array(512);
  micIssue: string | null = null;

  /** Microphone loudness 0..1 (for the level meter); 0 when there is no microphone. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 90);
  }

  get state(): "inactive" | "recording" | "paused" {
    return this.recorder?.state ?? "inactive";
  }

  /** `onPiece` gets every piece of the recording as it is produced (for live conversion). */
  async start({
    track: video,
    micOn,
    quality,
    onPiece,
  }: {
    track: MediaStreamTrack;
    micOn: boolean;
    quality: Quality;
    onPiece?: (piece: Blob) => void;
  }): Promise<void> {
    this.micIssue = null;
    const tracks: MediaStreamTrack[] = [video];
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const [micTrack] = this.mic.getAudioTracks();
      micTrack.enabled = micOn;
      tracks.push(micTrack);
      try {
        this.audioCtx = new AudioContext();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.audioCtx.createMediaStreamSource(this.mic).connect(this.analyser);
      } catch {
        this.analyser = null; // no meter, recording is unaffected
      }
    } catch (e) {
      this.mic = null;
      this.micIssue = `No microphone: ${(e as Error).message || "permission denied"}. Recording without sound.`;
    }
    this.chunks = [];
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: BITRATE[quality] ?? BITRATE.standard,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.chunks.push(e.data); // kept in full: the fallback if live conversion fails
      onPiece?.(e.data);
    };
    this.recorder.start(1000);
  }

  setMic(on: boolean) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  pause() {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume() {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return Promise.reject(new Error("Not recording."));
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.mic?.getTracks().forEach((t) => t.stop());
        void this.audioCtx?.close();
        this.audioCtx = null;
        this.analyser = null;
        this.mic = null;
        this.recorder = null;
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "video/webm" }));
      };
      recorder.stop();
    });
  }
}
