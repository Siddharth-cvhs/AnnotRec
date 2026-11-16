// Ports: everything the core needs from the outside world, as interfaces.
//
// The core never touches the browser's capture APIs, the network or
// localStorage directly. Adapters (src/adapters) implement these ports for the
// real thing; pass your own to createAnnotRec({ ports }) to change where
// recordings go, how pages are shown, or to run the core in a test with fakes.

import type { FileInfo, Quality, Saved } from "./types";

/** The shared screen/tab capture, cropped to the viewport element. */
export interface CapturePort {
  /** Can this browser do region capture at all? */
  readonly supported: boolean;
  readonly active: boolean;
  readonly track: MediaStreamTrack | null;
  /** Ask for permission and start; resolves once pictures are flowing. */
  start(element: HTMLElement): Promise<void>;
  /** Make the picture exactly the element's size in pixels (call when the size is final). */
  fit(): Promise<void>;
  /** The newest frame, in memory. */
  frame(): Promise<ImageBitmap>;
  toPng(frame: ImageBitmap): Promise<Blob>;
  release(): void;
  /** The user stopped sharing (browser UI) or the capture died. */
  onEnded(listener: () => void): () => void;
  /** Test hook: behave as if the user pressed "Stop sharing". */
  simulateEnd?(): void;
}

/** Records the capture track plus the microphone. */
export interface ClipPort {
  readonly state: "inactive" | "recording" | "paused";
  /** Why there is no sound, if the microphone could not be opened. */
  readonly micIssue: string | null;
  start(opts: { track: MediaStreamTrack; micOn: boolean; quality: Quality; onPiece?(piece: Blob): void }): Promise<void>;
  setMic(on: boolean): void;
  pause(): void;
  resume(): void;
  /** Ends the recording and resolves with the whole thing. */
  stop(): Promise<Blob>;
  /** Microphone loudness 0..1 (for a level meter). */
  level(): number;
}

/** Where a finished recording goes. */
export interface RecordingSink {
  id: string;
  label: string;
  order?: number;
  open(info: { quality: Quality }): Promise<SinkSession>;
}

export interface SinkSession {
  /** Called with every piece as it is recorded (live sinks send it on; others ignore it). */
  push(piece: Blob): void;
  /** The recording is over: `whole` is all of it. Resolves with what was saved. */
  finish(whole: Blob, info: { durationMs: number; quality: Quality; onProgress(fraction: number): void }): Promise<Saved>;
  /** Nothing will be finished (recording failed to start). */
  abort(): void;
}

export interface LibraryPort {
  list(): Promise<FileInfo[]>;
  remove(name: string): Promise<void>;
  reveal(name: string): Promise<void>;
  url(name: string, download?: boolean): string;
  saveImage(blob: Blob): Promise<{ name: string; size: number }>;
}

/** Chooses the page the viewport shows. */
export interface ViewportPort {
  /** Point the viewport at `address`; resolves with the URL the iframe should load. */
  setTarget(address: string): Promise<{ viewportUrl: string }>;
  /** The page shown until an address is chosen. */
  sampleUrl(): string;
}

export interface BackendPort {
  health(): Promise<{ ffmpeg: boolean; qualities: string[] }>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Ports {
  capture: CapturePort;
  clip: ClipPort;
  library: LibraryPort;
  viewport: ViewportPort;
  backend: BackendPort;
  storage: KeyValueStore;
}
