import { invoke } from "@tauri-apps/api/core";

export type Phase = "idle" | "recording" | "paused" | "stopping";

export interface AppState {
  phase: Phase;
  annotating: boolean;
  micOn: boolean;
  micName: string | null;
  elapsedMs: number;
  lastFile: string | null;
  message: string | null;
  url: string;
  viewport: [number, number];
}

export type Tool =
  | "live"
  | "pen"
  | "pencil"
  | "highlighter"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "eraser";

export type OverlayCmd =
  | { type: "tool"; tool: Tool }
  | { type: "color"; color: string }
  | { type: "width"; width: number }
  | { type: "undo" }
  | { type: "redo" };

export const api = {
  getState: () => invoke<AppState>("get_state"),
  navigate: (url: string) => invoke<void>("navigate", { url }),
  reload: () => invoke<void>("reload"),
  setViewport: (width: number, height: number) => invoke<void>("set_viewport", { width, height }),
  setMic: (on: boolean) => invoke<void>("set_mic", { on }),
  start: () => invoke<void>("start_recording"),
  pause: () => invoke<void>("pause_recording"),
  resume: () => invoke<void>("resume_recording"),
  stop: () => invoke<void>("stop_recording"),
  screenshot: () => invoke<void>("take_screenshot"),
  setTool: (tool: Tool) => invoke<void>("set_tool", { tool }),
  overlayCmd: (cmd: OverlayCmd) => invoke<void>("overlay_cmd", { cmd }),
  clearAll: () => invoke<void>("clear_all"),
  openFolder: () => invoke<void>("open_folder"),
};
