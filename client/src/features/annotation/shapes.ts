// The built-in kinds of drawing. Each is a ShapeKind registered in
// kernel.shapes; a plugin adds a new kind (a stamp, a callout...) the same way
// and then a tool that produces it.

import type { Bounds, Shape, ShapeKind } from "../../core/contracts";
import type { Registry } from "../../core/registry";
import type { Pt } from "../../core/types";

// --- typed views of the generic Shape ---------------------------------------
export interface Stroke extends Shape {
  pts: Pt[];
  width: number;
}
export interface Segment extends Shape {
  a: Pt;
  b: Pt;
  width: number;
}
export interface TextShape extends Shape {
  p: Pt;
  text: string;
  size: number;
}
export interface Marker extends Shape {
  p: Pt;
  n: number;
  size: number;
}

export const textSize = (width: number) => Math.max(18, width * 6);
export const markerSize = (width: number) => Math.max(26, width * 6);

// --- geometry ---------------------------------------------------------------
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const mv = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });

/** Black or white, whichever reads on `hex`. */
function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111" : "#fff";
}

// --- freehand strokes (pen, pencil, highlighter) -----------------------------
function strokePath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
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
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function freehandKind(id: string, o: { lineWidth(width: number): number; alpha?: number; cap?: CanvasLineCap }): ShapeKind {
  return {
    id,
    draw(ctx, shape) {
      const s = shape as Stroke;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = o.cap ?? "round";
      ctx.globalAlpha = o.alpha ?? 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = o.lineWidth(s.width);
      strokePath(ctx, s.pts);
      ctx.restore();
    },
    bounds(shape): Bounds {
      const s = shape as Stroke;
      const pad = o.lineWidth(s.width) / 2;
      const xs = s.pts.map((p) => p.x);
      const ys = s.pts.map((p) => p.y);
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    },
    hit(shape, p, slack = 8) {
      const s = shape as Stroke;
      const w = o.lineWidth(s.width) / 2 + slack;
      if (s.pts.length === 1) return Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= w;
      for (let i = 1; i < s.pts.length; i++) if (distToSegment(p, s.pts[i - 1], s.pts[i]) <= w) return true;
      return false;
    },
    translate: (shape, dx, dy) => ({ ...shape, pts: (shape as Stroke).pts.map((p) => mv(p, dx, dy)) }) as Shape,
  };
}

// --- two-point shapes (line, arrow, rectangle, ellipse) ----------------------
function twoPointKind(
  id: string,
  o: {
    draw(ctx: CanvasRenderingContext2D, s: Segment): void;
    hit(s: Segment, p: Pt, slack: number): boolean;
    pad?(s: Segment): number;
  },
): ShapeKind {
  return {
    id,
    draw(ctx, shape) {
      const s = shape as Segment;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      o.draw(ctx, s);
      ctx.restore();
    },
    bounds(shape): Bounds {
      const s = shape as Segment;
      const pad = s.width / 2 + (o.pad?.(s) ?? 0);
      const x = Math.min(s.a.x, s.b.x) - pad;
      const y = Math.min(s.a.y, s.b.y) - pad;
      return { x, y, w: Math.abs(s.b.x - s.a.x) + pad * 2, h: Math.abs(s.b.y - s.a.y) + pad * 2 };
    },
    hit: (shape, p, slack = 8) => o.hit(shape as Segment, p, slack),
    translate: (shape, dx, dy) => {
      const s = shape as Segment;
      return { ...s, a: mv(s.a, dx, dy), b: mv(s.b, dx, dy) } as Shape;
    },
  };
}

const line = (ctx: CanvasRenderingContext2D, s: Segment) => {
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  ctx.lineTo(s.b.x, s.b.y);
  ctx.stroke();
};

const lineHit = (s: Segment, p: Pt, slack: number) => distToSegment(p, s.a, s.b) <= s.width / 2 + slack;

// --- text and markers -------------------------------------------------------
function textBounds(s: TextShape): Bounds {
  const lines = s.text.split("\n");
  return { x: s.p.x, y: s.p.y, w: Math.max(...lines.map((l) => l.length)) * s.size * 0.6, h: lines.length * s.size * 1.2 };
}

function boxHit(b: Bounds, p: Pt, slack: number): boolean {
  return p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack;
}

export function registerBuiltInShapes(shapes: Registry<ShapeKind>) {
  shapes.add(freehandKind("pen", { lineWidth: (w) => w }));
  shapes.add(freehandKind("pencil", { lineWidth: (w) => Math.max(1, w * 0.5) }));
  shapes.add(freehandKind("highlighter", { lineWidth: (w) => w * 4, alpha: 0.35, cap: "butt" }));

  shapes.add(twoPointKind("line", { draw: line, hit: lineHit }));

  shapes.add(
    twoPointKind("arrow", {
      pad: () => 6,
      hit: lineHit,
      draw(ctx, s) {
        line(ctx, s);
        const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
        const head = Math.max(14, s.width * 4);
        ctx.beginPath();
        ctx.moveTo(s.b.x, s.b.y);
        ctx.lineTo(s.b.x - head * Math.cos(angle - Math.PI / 7), s.b.y - head * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(s.b.x - head * Math.cos(angle + Math.PI / 7), s.b.y - head * Math.sin(angle + Math.PI / 7));
        ctx.closePath();
        ctx.fill();
      },
    }),
  );

  shapes.add(
    twoPointKind("rect", {
      draw: (ctx, s) =>
        ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y)),
      hit(s, p, slack) {
        const x0 = Math.min(s.a.x, s.b.x);
        const x1 = Math.max(s.a.x, s.b.x);
        const y0 = Math.min(s.a.y, s.b.y);
        const y1 = Math.max(s.a.y, s.b.y);
        const edge = s.width / 2 + slack;
        const inside = p.x >= x0 - edge && p.x <= x1 + edge && p.y >= y0 - edge && p.y <= y1 + edge;
        const deep = p.x > x0 + edge && p.x < x1 - edge && p.y > y0 + edge && p.y < y1 - edge;
        return inside && !deep;
      },
    }),
  );

  shapes.add(
    twoPointKind("ellipse", {
      draw(ctx, s) {
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
      },
      hit(s, p, slack) {
        const rx = Math.max(1, Math.abs(s.b.x - s.a.x) / 2);
        const ry = Math.max(1, Math.abs(s.b.y - s.a.y) / 2);
        const k = Math.hypot((p.x - (s.a.x + s.b.x) / 2) / rx, (p.y - (s.a.y + s.b.y) / 2) / ry);
        return Math.abs(k - 1) <= (s.width / 2 + slack) / Math.min(rx, ry);
      },
    }),
  );

  shapes.add({
    id: "text",
    draw(ctx, shape) {
      const s = shape as TextShape;
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.font = `600 ${s.size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      s.text.split("\n").forEach((l, i) => ctx.fillText(l, s.p.x, s.p.y + i * s.size * 1.2));
      ctx.restore();
    },
    bounds: (shape) => textBounds(shape as TextShape),
    hit: (shape, p, slack = 8) => boxHit(textBounds(shape as TextShape), p, slack),
    translate: (shape, dx, dy) => ({ ...shape, p: mv((shape as TextShape).p, dx, dy) }) as Shape,
  });

  const markerBounds = (s: Marker): Bounds => ({ x: s.p.x - s.size / 2, y: s.p.y - s.size / 2, w: s.size, h: s.size });
  shapes.add({
    id: "marker",
    draw(ctx, shape) {
      const s = shape as Marker;
      const r = s.size / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.p.x, s.p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
      ctx.fillStyle = contrastOn(s.color);
      ctx.font = `700 ${Math.round(r * 1.1)}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.n), s.p.x, s.p.y + 1);
      ctx.restore();
    },
    bounds: (shape) => markerBounds(shape as Marker),
    hit: (shape, p, slack = 8) => boxHit(markerBounds(shape as Marker), p, slack),
    translate: (shape, dx, dy) => ({ ...shape, p: mv((shape as Marker).p, dx, dy) }) as Shape,
  });
}
