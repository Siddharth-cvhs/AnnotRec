// Domain types shared by services, adapters and features.

/** Encoder quality: the server decides which exist (see /api/health). */
export type Quality = string;

/** idle -> countdown -> recording <-> paused -> saving -> idle */
export type Phase = "idle" | "countdown" | "recording" | "paused" | "saving";

export interface FileInfo {
  name: string;
  size: number;
  time: number;
  durationMs: number | null;
}

export interface Saved {
  name: string;
  size: number;
  durationMs: number;
}

export interface Settings {
  color: string;
  width: number;
  micOn: boolean;
  /** Seconds counted down before a recording starts (0 = off). */
  countdown: number;
  quality: Quality;
  /** The last address shown in the viewport ("" = the built-in sample page). */
  address: string;
  /** Id of the RecordingSink recordings are sent to. */
  sink: string;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  action?: { label: string; run(): void };
}

export type SizeMode = { kind: "fit" } | { kind: "fixed"; w: number; h: number };

export interface InkState {
  canUndo: boolean;
  canRedo: boolean;
  count: number;
  selected: boolean;
}

export interface Pt {
  x: number;
  y: number;
}
