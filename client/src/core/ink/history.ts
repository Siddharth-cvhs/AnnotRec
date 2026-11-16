import type { Shape } from "../contracts";

/** The drawing's shapes plus undo / redo as snapshots (drawings are small). */
export class History {
  shapes: Shape[] = [];
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];

  /** Call before changing `shapes`. */
  checkpoint() {
    this.undoStack.push(this.shapes.slice());
    this.redoStack = [];
  }

  /** Undoes a `checkpoint` that turned out to change nothing. */
  discardCheckpoint() {
    this.undoStack.pop();
  }

  add(s: Shape) {
    this.checkpoint();
    this.shapes = [...this.shapes, s];
  }

  /** Replaces a shape in place (moving it). No history entry: `checkpoint` first. */
  replace(next: Shape) {
    this.shapes = this.shapes.map((s) => (s.id === next.id ? next : s));
  }

  remove(id: number) {
    this.checkpoint();
    this.shapes = this.shapes.filter((s) => s.id !== id);
  }

  /** The number the next numbered marker should carry. */
  nextMarker(): number {
    return this.shapes.reduce((m, s) => (s.kind === "marker" ? Math.max(m, Number(s.n)) : m), 0) + 1;
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

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  reset() {
    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
  }
}
