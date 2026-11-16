// A complete example of extending AnnotRec WITHOUT touching its code.
//
// This one plugin adds:
//   - a new kind of drawing (a check mark) and a tool that draws it, with its shortcut
//   - a command ("notes.add") and a keyboard shortcut for it
//   - a card in the sidebar and a button in the Record card
//   - reactions to events from the core (a recording or screenshot was saved)
//   - state of its own (a store), persisted through the settings service
//
// And `downloadSink` below is a different place for recordings to go (the
// browser's download, no server involved).

import { Stamp, StickyNote } from "lucide-react";
import type { Plugin, RecordingSink, Shape, ShapeKind } from "../index";
import { createStore, useKernel, useStore } from "../index";
import type { Pt } from "../core/types";

interface StampShape extends Shape {
  p: Pt;
  size: number;
}

const stampBounds = (s: StampShape) => ({ x: s.p.x - s.size / 2, y: s.p.y - s.size / 2, w: s.size, h: s.size });

/** 1. A new shape kind: a check mark in a circle. */
const stampKind: ShapeKind = {
  id: "stamp",
  draw(ctx, shape) {
    const s = shape as StampShape;
    const r = s.size / 2;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.p.x, s.p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.p.x - r * 0.45, s.p.y);
    ctx.lineTo(s.p.x - r * 0.1, s.p.y + r * 0.4);
    ctx.lineTo(s.p.x + r * 0.5, s.p.y - r * 0.4);
    ctx.stroke();
    ctx.restore();
  },
  bounds: (shape) => stampBounds(shape as StampShape),
  hit: (shape, p, slack = 8) => {
    const b = stampBounds(shape as StampShape);
    return p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack;
  },
  translate: (shape, dx, dy) => ({ ...shape, p: { x: (shape as StampShape).p.x + dx, y: (shape as StampShape).p.y + dy } }) as Shape,
};

export const notesPlugin: Plugin = {
  id: "notes",
  setup(k) {
    // 5. State of its own, remembered between visits.
    const prefs = k.services.settings.namespace("notes");
    const notes = createStore({ lines: prefs.get<string[]>("lines", []) });
    const add = (text: string) => {
      const lines = [...notes.get().lines, `${new Date().toLocaleTimeString()}  ${text}`].slice(-20);
      notes.set({ lines });
      prefs.set("lines", lines);
    };

    function NotesCard() {
      const lines = useStore(notes, (s) => s.lines);
      return (
        <section className="card" data-testid="notes-card" aria-labelledby="notes-title">
          <h2 id="notes-title">Notes</h2>
          {lines.length === 0 ? <p className="empty">Nothing yet. Press Ctrl+Shift+N.</p> : null}
          <ul data-testid="notes-lines" style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12 }}>
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      );
    }

    function NoteButton() {
      const kernel = useKernel();
      return (
        <button className="btn" data-testid="note-button" title="Add a note (Ctrl+Shift+N)" onClick={() => void kernel.run("notes.add")}>
          <StickyNote size={16} /> Note
        </button>
      );
    }

    const off = [
      // 1. A new shape and the tool that draws it. The annotation feature gives the tool its button and its "K" shortcut.
      k.shapes.add(stampKind),
      k.tools.add({
        id: "stamp",
        order: 105,
        label: "Check mark",
        short: "Check",
        key: "k",
        icon: Stamp,
        behavior: {
          pointerDown(ctx, p) {
            ctx.history.add({ id: ctx.newId(), kind: "stamp", color: ctx.color, p, size: 34 } as Shape);
            ctx.changed();
            ctx.render();
          },
        },
      }),

      // 2. A command and its shortcut.
      k.commands.add({ id: "notes.add", title: "Add a note", run: () => add("Note") }),
      k.shortcuts.add({ id: "notes.add", keys: "ctrl+shift+n", command: "notes.add" }),

      // 3. UI: a sidebar card and a button in the Record card.
      k.panels.add({ id: "notes.card", slot: "sidebar", order: 25, component: NotesCard }),
      k.panels.add({ id: "notes.button", slot: "record.actions", order: 30, component: NoteButton }),

      // 4. React to what happens in the core, without the core knowing this plugin exists.
      k.bus.on("recording:saved", ({ file }) => add(`Saved ${file.name}`)),
      k.bus.on("screenshot:saved", (file) => add(`Screenshot ${file.name}`)),
    ];
    return () => off.forEach((f) => f());
  },
};

/**
 * A RecordingSink that hands the recording to the browser as a download: no
 * server, no conversion. (WebM is what the browser records.) Offered next to
 * the server sink in Settings > "Save recordings to".
 */
export const downloadSink: RecordingSink = {
  id: "download",
  label: "Download the WebM in the browser (no server)",
  order: 10,
  async open() {
    return {
      push() {},
      async finish(whole, { durationMs }) {
        const name = `recording-${Date.now()}.webm`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(whole);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        return { name, size: whole.size, durationMs };
      },
      abort() {},
    };
  },
};
