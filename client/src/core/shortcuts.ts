import type { Shortcut } from "./contracts";
import type { Kernel } from "./kernel";

const MOD_ORDER = ["ctrl", "alt", "shift"];

/** Canonical form of a chord: modifiers in a fixed order, the key lower-cased. */
export function normalizeChord(keys: string): string {
  const parts = keys.toLowerCase().split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = [...new Set(parts.map((m) => (m === "cmd" || m === "meta" ? "ctrl" : m)))].sort(
    (a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b),
  );
  return [...mods, key].join("+");
}

/** The chord a key event represents. Shift is dropped for punctuation ("?" is not "shift+/"). */
export function chordOf(e: KeyboardEvent): string {
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) mods.push("shift");
  return [...mods, key].join("+");
}

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

/** Turns key presses into commands, using the kernel's `shortcuts` registry. */
export class ShortcutManager {
  constructor(private readonly kernel: Kernel) {}

  attach(target: Window = window): () => void {
    target.addEventListener("keydown", this.onKey);
    return () => target.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    const chord = chordOf(e);
    const typing = isTyping(e.target);
    const candidates = this.kernel.shortcuts
      .list()
      .filter((s) => normalizeChord(s.keys) === chord && (!typing || s.inInput))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const s of candidates) {
      if (this.fire(s, e)) {
        e.preventDefault();
        return;
      }
    }
  };

  private fire(s: Shortcut, e: KeyboardEvent): boolean {
    if (s.when && !s.when(this.kernel, e)) return false;
    const command = this.kernel.commands.get(s.command);
    if (!command || (command.enabled && !command.enabled(this.kernel))) return false;
    void this.kernel.run(s.command, s.args);
    return true;
  }
}
