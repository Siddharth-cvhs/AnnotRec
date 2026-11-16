import { useEffect, useMemo } from "react";
import { createAnnotRec, type AnnotRecOptions } from "./create";
import type { Kernel } from "./core/kernel";
import { KernelProvider } from "./ui/context";
import { Shell } from "./ui/Shell";

export interface AnnotRecProps extends AnnotRecOptions {
  /** Use a kernel you built yourself (otherwise one is created from the other props). */
  kernel?: Kernel;
}

/**
 * The whole app as one React component:
 *
 *   <AnnotRec apiBase="/tools/annotrec" plugins={[myPlugin]} />
 *
 * It lays out the shell and renders whatever features are installed.
 */
export function AnnotRec({ kernel, ...options }: AnnotRecProps) {
  // The kernel is made once per mount; changing options later needs a new key or your own kernel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const k = useMemo(() => kernel ?? createAnnotRec(options), [kernel]);

  useEffect(() => {
    const detach = k.attachKeyboard();
    void k.start();
    // Test hooks (only when the page opted in): lets the end-to-end suite pretend the user pressed "Stop sharing" and read the mic level.
    try {
      if (localStorage.getItem("annotrecTest")) {
        (window as unknown as Record<string, unknown>).__annotrec = {
          kernel: k,
          endSession: () => k.services.capture.simulateEnd(),
          micLevel: () => k.services.recording.level(),
        };
      }
    } catch {
      /* storage unavailable */
    }
    return detach;
  }, [k]);

  return (
    <KernelProvider kernel={k}>
      <Shell />
    </KernelProvider>
  );
}
