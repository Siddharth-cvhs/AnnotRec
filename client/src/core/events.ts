import type { Phase, Saved } from "./types";

/**
 * Everything that happens, as events on `kernel.bus`. Services emit them;
 * features listen. This is how modules react to each other without importing
 * each other (for example the library shows a "Saved" toast when the
 * recording service says a recording was saved).
 *
 * A plugin can add its own events with declaration merging:
 *   declare module "annotrec" { interface AppEvents { "my:event": { n: number } } }
 */
export interface AppEvents {
  "capture:started": void;
  "capture:ended": void;
  "recording:phase": { phase: Phase; previous: Phase };
  "recording:started": void;
  "recording:saved": { file: Saved };
  "recording:failed": { error: string };
  "annotation:frozen": void;
  "annotation:live": void;
  "annotation:tool": { tool: string };
  "screenshot:saved": { name: string; size: number };
  "viewport:navigated": { address: string; url: string };
}
