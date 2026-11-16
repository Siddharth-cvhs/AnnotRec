import type { Plugin } from "../../core/contracts";
import { useKernel, useStore } from "../../ui/context";
import { Library } from "./Library";
import { Player } from "./Player";

/** The "get started" hint under the viewport, shown until there is something saved. */
function GettingStarted() {
  const k = useKernel();
  const files = useStore(k.services.library.store, (s) => s.files.length);
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  const sharing = useStore(k.services.capture.store, (s) => s.active);
  if (phase === "recording" || phase === "paused" || sharing || files > 0) return null;
  return (
    <ol className="getting-started" data-testid="getting-started">
      <li>
        <b>1</b> Enter the page’s address above
      </li>
      <li>
        <b>2</b> Press <kbd>R</kbd> and share “This tab”
      </li>
      <li>
        <b>3</b> Pick a tool to freeze the page and explain
      </li>
    </ol>
  );
}

/**
 * The library: the Saved list, the player dialog, and the reactions to a
 * recording or screenshot being saved (refresh the list, show a toast).
 * Nothing else needs to know the library exists: it only listens to events.
 */
export const libraryPlugin: Plugin = {
  id: "library",
  setup(k) {
    const { library, notifier, ui } = k.services;
    const off = [
      k.panels.add({ id: "library.list", slot: "sidebar", order: 30, component: Library }),
      k.panels.add({ id: "library.gettingStarted", slot: "stage.bottom", order: 10, component: GettingStarted }),
      k.modals.add({ id: "player", title: (p) => (p as { file: { name: string } }).file.name, wide: true, component: Player }),

      k.bus.on("recording:saved", ({ file }) => {
        void library.refresh();
        notifier.success(`Saved ${file.name}`, {
          label: "Play",
          run: () => ui.open("player", { file: { name: file.name, size: file.size, time: Date.now(), durationMs: file.durationMs } }),
        });
      }),
      k.bus.on("screenshot:saved", (file) => {
        void library.refresh();
        notifier.success(`Screenshot saved: ${file.name}`, {
          label: "View",
          run: () => ui.open("player", { file: { name: file.name, size: file.size, time: Date.now(), durationMs: null } }),
        });
      }),
    ];
    return () => off.forEach((f) => f());
  },
};
