import { CircleHelp, Settings2 } from "lucide-react";
import type { Plugin } from "../../core/contracts";
import { useKernel, useRegistry, useStore } from "../../ui/context";

const SHORTCUTS: [string, string][] = [
  ["R", "Start recording"],
  ["Space", "Pause / resume"],
  ["Shift + R", "Stop and save"],
  ["S", "Screenshot"],
  ["Shift + M", "Mic on / off"],
  ["V B N H", "Select, pen, pencil, highlighter"],
  ["L A U O", "Line, arrow, rectangle, circle"],
  ["T M E", "Text, numbered marker, eraser"],
  ["Shift (while drawing)", "Straight lines, squares, circles"],
  ["Ctrl + Z / Ctrl + Y", "Undo / redo"],
  ["Delete", "Delete the selected shape"],
  ["Esc", "Clear drawings and go live (or cancel the countdown)"],
  ["?", "This help"],
];

function Help() {
  return (
    <>
      <ol className="steps">
        <li>
          <b>Pick the page.</b> Type its address (for example <code>localhost:3000</code>) and press Go.
        </li>
        <li>
          <b>Record.</b> Press Start and choose “This tab” when your browser asks. Only the viewport is recorded.
        </li>
        <li>
          <b>Explain.</b> Pick a drawing tool: the page freezes while you draw and talk, and recording continues.{" "}
          <b>Clear all</b> brings the live page back.
        </li>
        <li>
          <b>Save.</b> Stop converts the clip to an MP4 you can play, download or open in its folder.
        </li>
      </ol>
      <h3>Keyboard shortcuts</h3>
      <table className="keys">
        <tbody>
          {SHORTCUTS.map(([keys, description]) => (
            <tr key={keys}>
              <td>
                {keys.split(" ").map((part, i) =>
                  ["+", "/", "(while", "drawing)"].includes(part) ? <span key={i}> {part} </span> : <kbd key={i}>{part}</kbd>,
                )}
              </td>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Shortcuts work when this page has focus: click outside the viewport first if you were using the page.</p>
    </>
  );
}

const QUALITY_LABELS: Record<string, string> = {
  standard: "Standard (smaller files)",
  high: "High (sharper text, larger files, slower to save)",
};

function Settings() {
  const k = useKernel();
  const settings = useStore(k.services.settings.store);
  const qualities = useStore(k.services.backend.store, (s) => s.qualities);
  const sinks = useRegistry(k.sinks);
  const patch = k.services.settings.patch.bind(k.services.settings);
  return (
    <>
      <div className="field">
        <label htmlFor="countdown">Countdown before recording</label>
        <select id="countdown" data-testid="setting-countdown" value={settings.countdown} onChange={(e) => patch({ countdown: Number(e.target.value) })}>
          <option value={0}>Off</option>
          <option value={3}>3 seconds</option>
          <option value={5}>5 seconds</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="quality">Video quality</label>
        <select id="quality" data-testid="setting-quality" value={settings.quality} onChange={(e) => patch({ quality: e.target.value })}>
          {qualities.map((q) => (
            <option key={q} value={q}>
              {QUALITY_LABELS[q] ?? q}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="mic">Microphone</label>
        <select id="mic" value={settings.micOn ? "on" : "off"} onChange={(e) => patch({ micOn: e.target.value === "on" })}>
          <option value="on">On when recording starts</option>
          <option value="off">Off when recording starts</option>
        </select>
      </div>
      {sinks.length > 1 && (
        <div className="field">
          <label htmlFor="sink">Save recordings to</label>
          <select id="sink" data-testid="setting-sink" value={settings.sink} onChange={(e) => patch({ sink: e.target.value })}>
            {sinks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="hint">Settings are remembered in this browser.</p>
    </>
  );
}

function SettingsButton() {
  const k = useKernel();
  return (
    <button className="icon-btn" title="Settings" aria-label="Settings" data-testid="open-settings" onClick={() => void k.run("dialogs.settings")}>
      <Settings2 size={18} />
    </button>
  );
}

function HelpButton() {
  const k = useKernel();
  return (
    <button className="icon-btn" title="Shortcuts and help (?)" aria-label="Help" data-testid="open-help" onClick={() => void k.run("dialogs.help")}>
      <CircleHelp size={18} />
    </button>
  );
}

/** The Help and Settings dialogs, their top-bar buttons and the "?" shortcut. */
export const dialogsPlugin: Plugin = {
  id: "dialogs",
  setup(k) {
    const ui = k.services.ui;
    const off = [
      k.modals.add({ id: "help", title: "How it works", component: Help }),
      k.modals.add({ id: "settings", title: "Settings", component: Settings }),
      k.commands.add({ id: "dialogs.help", title: "Help and shortcuts", run: () => ui.toggle("help") }),
      k.commands.add({ id: "dialogs.settings", title: "Settings", run: () => ui.open("settings") }),
      k.commands.add({ id: "dialogs.close", title: "Close the dialog", run: () => ui.close() }),
      k.shortcuts.add({ id: "dialogs.help", keys: "?", command: "dialogs.help" }),
      k.shortcuts.add({
        id: "dialogs.close",
        keys: "escape",
        command: "dialogs.close",
        priority: 10, // the last resort for Escape
        when: () => ui.store.get().modal !== null,
      }),
      k.panels.add({ id: "dialogs.settingsButton", slot: "topbar.right", order: 10, component: SettingsButton }),
      k.panels.add({ id: "dialogs.helpButton", slot: "topbar.right", order: 20, component: HelpButton }),
    ];
    return () => off.forEach((f) => f());
  },
};
