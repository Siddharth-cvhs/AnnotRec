import type { Plugin } from "../../core/contracts";
import { RecordCard } from "./RecordCard";
import { CountdownLayer, MicButton, StatusPill } from "./parts";

/** Recording: start, pause, stop, microphone, countdown. */
export const recordingPlugin: Plugin = {
  id: "recording",
  setup(k) {
    const rec = k.services.recording;
    const isRecording = () => rec.phase === "recording" || rec.phase === "paused";
    const off = [
      k.commands.add({ id: "recording.start", title: "Start recording", run: () => rec.start() }),
      k.commands.add({ id: "recording.pause", title: "Pause recording", run: () => rec.pause() }),
      k.commands.add({ id: "recording.resume", title: "Resume recording", run: () => rec.resume() }),
      k.commands.add({
        id: "recording.togglePause",
        title: "Pause or resume",
        run: () => (rec.phase === "recording" ? rec.pause() : rec.resume()),
      }),
      k.commands.add({ id: "recording.stop", title: "Stop and save", run: () => rec.stop() }),
      k.commands.add({ id: "recording.cancelCountdown", title: "Cancel the countdown", run: () => rec.cancelCountdown() }),
      k.commands.add({ id: "recording.toggleMic", title: "Microphone on / off", run: () => rec.toggleMic() }),

      k.shortcuts.add({ id: "recording.start", keys: "r", command: "recording.start", when: () => rec.phase === "idle" }),
      k.shortcuts.add({ id: "recording.stop", keys: "shift+r", command: "recording.stop", when: isRecording }),
      k.shortcuts.add({
        id: "recording.togglePause",
        keys: "space",
        command: "recording.togglePause",
        // A focused button treats Space as a click: let it.
        when: (_k, e) => isRecording() && !["BUTTON", "A"].includes((e.target as HTMLElement | null)?.tagName ?? ""),
      }),
      k.shortcuts.add({ id: "recording.toggleMic", keys: "shift+m", command: "recording.toggleMic" }),
      k.shortcuts.add({
        id: "recording.cancelCountdown",
        keys: "escape",
        command: "recording.cancelCountdown",
        priority: 30, // before "leave annotation" and "close dialog"
        when: () => rec.phase === "countdown",
      }),

      k.panels.add({ id: "recording.card", slot: "sidebar", order: 10, component: RecordCard }),
      k.panels.add({ id: "recording.status", slot: "topbar.center", order: 10, component: StatusPill }),
      k.panels.add({ id: "recording.countdown", slot: "stage.layer", order: 90, component: CountdownLayer }),
      k.panels.add({ id: "recording.mic", slot: "record.actions", order: 10, component: MicButton }),
    ];

    // Closing or reloading the tab mid-recording (or while saving) would lose it: ask first.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    let warning = false;
    off.push(
      rec.store.subscribe(() => {
        const needed = rec.phase === "recording" || rec.phase === "paused" || rec.phase === "saving";
        if (needed === warning) return;
        warning = needed;
        if (needed) window.addEventListener("beforeunload", warn);
        else window.removeEventListener("beforeunload", warn);
      }),
    );

    return () => {
      off.forEach((f) => f());
      window.removeEventListener("beforeunload", warn);
    };
  },
};
