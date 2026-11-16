import { Camera } from "lucide-react";
import type { Plugin } from "../../core/contracts";
import { useKernel, useStore } from "../../ui/context";

function ScreenshotButton() {
  const k = useKernel();
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  return (
    <button
      className="btn"
      disabled={!k.services.capture.supported || phase === "saving"}
      onClick={() => void k.run("screenshot.take")}
      data-testid="screenshot"
      title="Screenshot (S)"
    >
      <Camera size={16} /> Screenshot <kbd>S</kbd>
    </button>
  );
}

/**
 * Screenshot: save a picture of the viewport (with any ink on it). A good
 * example of a small self-contained feature: one command, one shortcut, one
 * button in the Record card, and an event for others to react to.
 */
export const screenshotPlugin: Plugin = {
  id: "screenshot",
  setup(k) {
    const { capture, library } = k.services;
    const off = [
      k.commands.add({
        id: "screenshot.take",
        title: "Take a screenshot",
        async run() {
          await capture.ensure();
          const frame = await capture.frame();
          try {
            const saved = await library.saveImage(await capture.toPng(frame));
            k.bus.emit("screenshot:saved", saved);
          } finally {
            frame.close();
          }
        },
      }),
      k.shortcuts.add({ id: "screenshot.take", keys: "s", command: "screenshot.take", when: () => k.services.recording.phase !== "saving" }),
      k.panels.add({ id: "screenshot.button", slot: "record.actions", order: 20, component: ScreenshotButton }),
    ];
    return () => off.forEach((f) => f());
  },
};
