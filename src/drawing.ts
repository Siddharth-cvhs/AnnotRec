// Vector annotation model: shapes, rendering, eraser hit-testing, history.
// Plain data + a 2D canvas, so the overlay stays light and the strokes stay
// crisp at any display scaling.

export interface Pt {
  x: number;
  y: number;
}

export type Shape =
  | { id: number; kind: "pen" | "pencil" | "highlighter"; pts: Pt[]; color: string; width: number }
  | { id: number; kind: "line" | "arrow" | "rect" | "ellipse"; a: Pt; b: Pt; color: string; width: number }
  | { id: number; kind: "text"; p: Pt; text: string; color: string; size: number };

export type Freehand = Extract<Shape, { pts: Pt[] }>;
export type TwoPoint = Extract<Shape, { a: Pt }>;
export const isFreehand = (s: Shape): s is Freehand => "pts" in s;
export const isTwoPoint = (s: Shape): s is TwoPoint => "a" in s;

export type DrawKind = "pen" | "pencil" | "highlighter" | "line" | "arrow" | "rect" | "ellipse";

let nextId = 1;
export const newId = () => nextId++;

export function textSize(width: number): number {
  return Math.max(18, width * 6);
}

// ------------------------------------------------------------------ render

function strokeFreehand(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (s.kind) {
    case "pen":
    case "pencil":
    case "highlighter": {
      ctx.strokeStyle = s.color;
      if (s.kind === "highlighter") {
        ctx.globalAlpha = 0.35;
        ctx.lineCap = "butt";
        ctx.lineWidth = s.width * 4;
      } else {
        ctx.lineWidth = s.kind === "pencil" ? Math.max(1, s.width * 0.5) : s.width;
      }
      strokeFreehand(ctx, s.pts);
      break;
    }
    case "line":
    case "arrow": {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.a.x, s.a.y);
      ctx.lineTo(s.b.x, s.b.y);
      ctx.stroke();
      if (s.kind === "arrow") {
        const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
        const head = Math.max(14, s.width * 4);
        ctx.beginPath();
        ctx.moveTo(s.b.x, s.b.y);
        ctx.lineTo(s.b.x - head * Math.cos(angle - Math.PI / 7), s.b.y - head * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(s.b.x - head * Math.cos(angle + Math.PI / 7), s.b.y - head * Math.sin(angle + Math.PI / 7));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "rect": {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
      break;
    }
    case "ellipse": {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.ellipse(
        (s.a.x + s.b.x) / 2,
        (s.a.y + s.b.y) / 2,
        Math.max(1, Math.abs(s.b.x - s.a.x) / 2),
        Math.max(1, Math.abs(s.b.y - s.a.y) / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.fillStyle = s.color;
      ctx.font = `600 ${s.size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.p.x, s.p.y + i * s.size * 1.2));
      break;
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------- hit testing

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `p` is on (or near, by `slack` px) the shape's ink. */
export function hits(s: Shape, p: Pt, slack = 8): boolean {
  switch (s.kind) {
    case "pen":
    case "pencil":
    case "highlighter": {
      const w = (s.kind === "highlighter" ? s.width * 4 : s.width) / 2 + slack;
      if (s.pts.length === 1) return Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= w;
      for (let i = 1; i < s.pts.length; i++) if (distToSegment(p, s.pts[i - 1], s.pts[i]) <= w) return true;
      return false;
    }
    case "line":
    case "arrow":
      return distToSegment(p, s.a, s.b) <= s.width / 2 + slack;
    case "rect": {
      const x0 = Math.min(s.a.x, s.b.x);
      const x1 = Math.max(s.a.x, s.b.x);
      const y0 = Math.min(s.a.y, s.b.y);
      const y1 = Math.max(s.a.y, s.b.y);
      const edge = s.width / 2 + slack;
      const inside = p.x >= x0 - edge && p.x <= x1 + edge && p.y >= y0 - edge && p.y <= y1 + edge;
      const deep = p.x > x0 + edge && p.x < x1 - edge && p.y > y0 + edge && p.y < y1 - edge;
      return inside && !deep;
    }
    case "ellipse": {
      const cx = (s.a.x + s.b.x) / 2;
      const cy = (s.a.y + s.b.y) / 2;
      const rx = Math.max(1, Math.abs(s.b.x - s.a.x) / 2);
      const ry = Math.max(1, Math.abs(s.b.y - s.a.y) / 2);
      const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      const tol = (s.width / 2 + slack) / Math.min(rx, ry);
      return Math.abs(k - 1) <= tol;
    }
    case "text": {
      const lines = s.text.split("\n");
      const w = Math.max(...lines.map((l) => l.length)) * s.size * 0.6;
      const h = lines.length * s.size * 1.2;
      return p.x >= s.p.x - slack && p.x <= s.p.x + w + slack && p.y >= s.p.y - slack && p.y <= s.p.y + h + slack;
    }
  }
}

// ----------------------------------------------------------------- history

/** Shapes plus undo / redo as snapshots (drawings are small). */
export class History {
  shapes: Shape[] = [];
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];

  /** Call before changing `shapes`. */
  checkpoint() {
    this.undoStack.push(this.shapes.slice());
    this.redoStack = [];
  }

  add(s: Shape) {
    this.checkpoint();
    this.shapes = [...this.shapes, s];
  }

  /** Removes the topmost shape under `p`; true when one went. */
  eraseAt(p: Pt, firstOfGesture: boolean): boolean {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if (hits(this.shapes[i], p)) {
        if (firstOfGesture) this.checkpoint();
        this.shapes = this.shapes.filter((_, j) => j !== i);
        return true;
      }
    }
    return false;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.shapes);
    this.shapes = prev;
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.shapes);
    this.shapes = next;
  }

  reset() {
    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
  }
}
