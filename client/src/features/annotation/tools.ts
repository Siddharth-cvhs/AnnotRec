// The built-in annotation tools. A tool is a ToolDef whose `behavior` receives
// the pointer events while the page is frozen. Register your own in
// kernel.tools (and a ShapeKind in kernel.shapes if it draws something new).

import {
  Circle,
  Eraser,
  Highlighter,
  ListOrdered,
  Minus,
  MousePointer2,
  Move,
  MoveUpRight,
  Pen,
  Pencil,
  Square,
  Type,
} from "lucide-react";
import type { ToolBehavior, ToolDef } from "../../core/contracts";
import type { Registry } from "../../core/registry";
import type { Pt } from "../../core/types";
import { markerSize, type Stroke } from "./shapes";

/** Shift held: straight lines snap to 45 degrees, rectangles become squares. */
function constrainLine(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + len * Math.cos(angle), y: a.y + len * Math.sin(angle) };
}

function constrainBox(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
}

/** Press, drag and the points you pass through become a stroke. */
export function freehand(kind: string): ToolBehavior {
  return {
    pointerDown(ctx, p) {
      ctx.draft = { id: ctx.newId(), kind, color: ctx.color, width: ctx.width, pts: [p] } as Stroke;
      ctx.render();
    },
    pointerMove(ctx, p, info) {
      const d = ctx.draft as Stroke | null;
      if (!d) return;
      // A fast stroke delivers several samples per event: keep them all.
      if (info.samples.length > 1) d.pts.push(...info.samples);
      else d.pts.push(p);
      ctx.render();
    },
    pointerUp(ctx) {
      const d = ctx.draft;
      ctx.draft = null;
      if (d) {
        ctx.history.add(d);
        ctx.changed();
      }
      ctx.render();
    },
  };
}

/** Press at one corner, drag to the other. `constrain` is applied while Shift is held. */
export function twoPoint(kind: string, constrain: (a: Pt, b: Pt) => Pt): ToolBehavior {
  return {
    pointerDown(ctx, p) {
      ctx.draft = { id: ctx.newId(), kind, color: ctx.color, width: ctx.width, a: p, b: p };
      ctx.render();
    },
    pointerMove(ctx, p, info) {
      const d = ctx.draft;
      if (!d) return;
      d.b = info.shift ? constrain(d.a as Pt, p) : p;
      ctx.render();
    },
    pointerUp(ctx) {
      const d = ctx.draft;
      ctx.draft = null;
      if (d) {
        const a = d.a as Pt;
        const b = d.b as Pt;
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 3) {
          ctx.history.add(d);
          ctx.changed();
        }
      }
      ctx.render();
    },
  };
}

const marker: ToolBehavior = {
  pointerDown(ctx, p) {
    ctx.history.add({ id: ctx.newId(), kind: "marker", p, n: ctx.history.nextMarker(), color: ctx.color, size: markerSize(ctx.width) });
    ctx.changed();
    ctx.render();
  },
};

const text: ToolBehavior = {
  cursor: "text",
  keepFocus: true, // the new text box must keep focus
  pointerDown(ctx, p) {
    if (!ctx.textAt) ctx.requestText(p); // a click away from an open box just commits it (blur)
  },
};

/** Click a shape to select it, drag to move it. */
function select(): ToolBehavior {
  let drag: { original: import("../../core/contracts").Shape; start: Pt; moved: boolean } | null = null;
  return {
    cursor: "default",
    pointerDown(ctx, p) {
      const hit = ctx.pick(p);
      ctx.select(hit?.id ?? null);
      if (hit) {
        ctx.history.checkpoint();
        drag = { original: hit, start: p, moved: false };
      }
    },
    pointerMove(ctx, p) {
      if (!drag) return;
      drag.moved = true;
      const kind = ctx.shapes.get(drag.original.kind);
      if (kind) ctx.history.replace(kind.translate(drag.original, p.x - drag.start.x, p.y - drag.start.y));
      ctx.render();
    },
    pointerUp(ctx) {
      if (!drag) return;
      if (!drag.moved) ctx.history.discardCheckpoint();
      drag = null;
      ctx.changed();
      ctx.render();
    },
  };
}

/** Click or drag across shapes to delete them (one undo step per gesture). */
function eraser(): ToolBehavior {
  let erasing = false;
  let started = false;
  const eraseAt = (ctx: Parameters<NonNullable<ToolBehavior["pointerDown"]>>[0], p: Pt, first: boolean): boolean => {
    const hit = ctx.pick(p);
    if (!hit) return false;
    if (first) ctx.history.checkpoint();
    ctx.history.shapes = ctx.history.shapes.filter((s) => s.id !== hit.id);
    ctx.changed();
    return true;
  };
  return {
    cursor: "cell",
    pointerDown(ctx, p) {
      erasing = true;
      started = eraseAt(ctx, p, true);
      ctx.render();
    },
    pointerMove(ctx, p) {
      if (!erasing) return;
      if (eraseAt(ctx, p, !started)) started = true;
      ctx.render();
    },
    pointerUp() {
      erasing = false;
    },
  };
}

export function registerBuiltInTools(tools: Registry<ToolDef>) {
  tools.add({ id: "select", order: 10, label: "Select and move", short: "Select", key: "v", icon: Move, behavior: select() });
  tools.add({ id: "pen", order: 20, label: "Pen", key: "b", icon: Pen, behavior: freehand("pen") });
  tools.add({ id: "pencil", order: 30, label: "Pencil", key: "n", icon: Pencil, behavior: freehand("pencil") });
  tools.add({ id: "highlighter", order: 40, label: "Highlighter", key: "h", icon: Highlighter, behavior: freehand("highlighter") });
  tools.add({ id: "line", order: 50, label: "Line (Shift = straight)", short: "Line", key: "l", icon: Minus, behavior: twoPoint("line", constrainLine) });
  tools.add({ id: "arrow", order: 60, label: "Arrow (Shift = straight)", short: "Arrow", key: "a", icon: MoveUpRight, behavior: twoPoint("arrow", constrainLine) });
  tools.add({ id: "rect", order: 70, label: "Rectangle (Shift = square)", short: "Rectangle", key: "u", icon: Square, behavior: twoPoint("rect", constrainBox) });
  tools.add({ id: "ellipse", order: 80, label: "Circle (Shift = round)", short: "Circle", key: "o", icon: Circle, behavior: twoPoint("ellipse", constrainBox) });
  tools.add({ id: "text", order: 90, label: "Text", key: "t", icon: Type, behavior: text });
  tools.add({ id: "marker", order: 100, label: "Numbered marker", short: "Numbered", key: "m", icon: ListOrdered, behavior: marker });
  tools.add({ id: "eraser", order: 110, label: "Eraser", key: "e", icon: Eraser, behavior: eraser() });
  // "Live" is a mode, not a drawing tool: it hands the page back.
  tools.add({ id: "live", order: 120, label: "Back to the live page", short: "Live", hint: "Esc", icon: MousePointer2 });
}
