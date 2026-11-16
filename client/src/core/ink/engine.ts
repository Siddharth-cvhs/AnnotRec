import type { PointerInfo, Shape, ShapeKind, ToolContext, ToolDef } from "../contracts";
import type { Registry } from "../registry";
import { createStore } from "../store";
import type { InkState, Pt } from "../types";
import { History } from "./history";

export interface InkEngineDeps {
  shapes: Registry<ShapeKind>;
  tools: Registry<ToolDef>;
  /** The current tool and style, read at the moment of each event. */
  props(): { tool: string; color: string; width: number };
}

let nextShapeId = 1;

/**
 * The annotation canvas without any UI framework: it keeps the shapes, paints
 * them onto a canvas and hands pointer events to the active tool. Tools and
 * shape kinds come from registries, so adding either needs no change here.
 */
export class InkEngine {
  readonly history = new History();
  /** What the UI shows about the ink; `textAt` is where a text box should be open (null = none). */
  readonly store = createStore<{ ink: InkState; textAt: Pt | null }>({
    ink: { canUndo: false, canRedo: false, count: 0, selected: false },
    textAt: null,
  });

  private canvas: HTMLCanvasElement | null = null;
  private observer: ResizeObserver | null = null;
  private raf = 0;
  private draft: Shape | null = null;
  private selected: number | null = null;

  constructor(private readonly deps: InkEngineDeps) {}

  // ------------------------------------------------------------ canvas

  /** Paint onto `canvas` and keep it sized; returns the detach function. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas;
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(canvas);
    this.render();
    return () => {
      this.observer?.disconnect();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.canvas = null;
    };
  }

  /** Repaint at most once per frame, however many pointer events arrive. */
  render = () => {
    if (!this.raf) this.raf = requestAnimationFrame(this.paint);
  };

  private paint = () => {
    this.raf = 0;
    const canvas = this.canvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const draw = (s: Shape) => this.deps.shapes.get(s.kind)?.draw(ctx, s);
    this.history.shapes.forEach(draw);
    if (this.draft) draw(this.draft);
    const sel = this.history.shapes.find((s) => s.id === this.selected);
    const kind = sel && this.deps.shapes.get(sel.kind);
    if (sel && kind) {
      const b = kind.bounds(sel);
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.restore();
    }
  };

  // ----------------------------------------------------------- pointer

  private get activeBehavior() {
    return this.deps.tools.get(this.deps.props().tool)?.behavior;
  }

  /** Does the active tool want the browser's default press behaviour suppressed? */
  get keepsFocus(): boolean {
    return this.activeBehavior?.keepFocus ?? false;
  }

  get cursor(): string {
    return this.activeBehavior?.cursor ?? "crosshair";
  }

  pointerDown(p: Pt, info: PointerInfo) {
    this.activeBehavior?.pointerDown?.(this.context(), p, info);
  }

  pointerMove(p: Pt, info: PointerInfo) {
    this.activeBehavior?.pointerMove?.(this.context(), p, info);
  }

  pointerUp() {
    this.activeBehavior?.pointerUp?.(this.context());
  }

  /** The context tools get. Built per event, so it always carries the current tool style. */
  private context(): ToolContext {
    const engine = this;
    const { color, width } = this.deps.props();
    return {
      color,
      width,
      shapes: this.deps.shapes,
      history: this.history,
      get draft() {
        return engine.draft;
      },
      set draft(value) {
        engine.draft = value;
      },
      get selectedId() {
        return engine.selected;
      },
      get textAt() {
        return engine.store.get().textAt;
      },
      select: (id) => this.select(id),
      requestText: (at) => this.store.set({ textAt: at }),
      newId: () => nextShapeId++,
      pick: (p) => this.pick(p),
      render: this.render,
      changed: () => this.report(),
    };
  }

  private pick(p: Pt): Shape | null {
    const shapes = this.history.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (this.deps.shapes.get(shapes[i].kind)?.hit(shapes[i], p)) return shapes[i];
    }
    return null;
  }

  // ----------------------------------------------------------- commands

  /** A finished text box: add the text, or nothing if it is empty. */
  commitText(value: string, color: string, size: number) {
    const at = this.store.get().textAt;
    this.store.set({ textAt: null });
    if (at && value.trim()) {
      this.history.add({ id: nextShapeId++, kind: "text", p: at, text: value, color, size });
      this.report();
      this.render();
    }
  }

  cancelText() {
    this.store.set({ textAt: null });
  }

  undo() {
    this.history.undo();
    this.selected = null;
    this.report();
    this.render();
  }

  redo() {
    this.history.redo();
    this.selected = null;
    this.report();
    this.render();
  }

  deleteSelected() {
    if (this.selected === null) return;
    this.history.remove(this.selected);
    this.selected = null;
    this.report();
    this.render();
  }

  /** Remove everything and forget the history. */
  clear() {
    this.history.reset();
    this.draft = null;
    this.selected = null;
    this.store.set({ textAt: null });
    this.report();
    this.render();
  }

  /** Called when the active tool changes: anything half-done is dropped. */
  toolChanged(tool: string) {
    if (tool !== "text") this.store.set({ textAt: null });
    if (tool !== "select" && this.selected !== null) this.select(null);
  }

  private select(id: number | null) {
    this.selected = id;
    this.report();
    this.render();
  }

  private report() {
    const h = this.history;
    this.store.set({
      ink: { canUndo: h.canUndo, canRedo: h.canRedo, count: h.shapes.length, selected: this.selected !== null },
    });
  }
}
