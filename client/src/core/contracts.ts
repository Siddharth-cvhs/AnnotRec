// Extension contracts: what a plugin can contribute.
//
// A feature is a Plugin. Its `setup(kernel)` registers entries into the
// kernel's registries; the built-in features use exactly this API, so a plugin
// of yours is a first-class citizen:
//
//   commands   things that can be done (by a button, a shortcut, another plugin)
//   shortcuts  key chords that run commands
//   tools      annotation tools (pen, arrow...)
//   shapes     the kinds of drawing a tool can produce
//   panels     React components placed in the UI slots
//   modals     dialogs
//   sinks      where finished recordings go

import type { ComponentType } from "react";
import type { Kernel } from "./kernel";
import type { Entry } from "./registry";
import type { Pt } from "./types";

export interface Plugin {
  id: string;
  /** Register things here. May return a cleanup function. */
  setup(kernel: Kernel): void | (() => void);
}

// ---------------------------------------------------------------- commands

export interface Command extends Entry {
  title?: string;
  run(kernel: Kernel, args?: unknown): void | Promise<void>;
  /** Greyed out / ignored when this returns false. */
  enabled?(kernel: Kernel): boolean;
}

export interface Shortcut extends Entry {
  /**
   * A key chord: "r", "shift+r", "ctrl+z", "space", "escape", "delete", "?".
   * Letters are case-insensitive; modifiers are ctrl (also cmd), shift, alt.
   */
  keys: string;
  command: string;
  args?: unknown;
  /** Only fires when this returns true. */
  when?(kernel: Kernel, event: KeyboardEvent): boolean;
  /** When several shortcuts share a chord, the highest priority whose `when` passes wins. */
  priority?: number;
  /** Also fire while typing in an input or text box (default: no). */
  inInput?: boolean;
}

// -------------------------------------------------------------------- slots

/**
 * Where a panel appears. The shell provides these; plugins may also render
 * their own <Slot name="..."/> and so create new places for others to fill.
 *
 *   topbar.left | topbar.center | topbar.right
 *   stage.top | stage.layer (inside the recorded viewport) | stage.bottom
 *   sidebar
 *   record.actions       the button row of the Record card
 *   global               overlays: toasts, modals
 */
export type SlotName = string;

export interface PanelDef extends Entry {
  slot: SlotName;
  component: ComponentType;
}

export interface ModalDef extends Entry {
  title: string | ((props: unknown) => string);
  wide?: boolean;
  component: ComponentType<{ props: unknown; close(): void }>;
}

// ----------------------------------------------------------- annotation

export interface Shape {
  id: number;
  kind: string;
  color: string;
  [extra: string]: unknown;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A kind of drawing: how to paint it, find it under the cursor, measure it and move it. */
export interface ShapeKind<S extends Shape = Shape> extends Entry {
  draw(ctx: CanvasRenderingContext2D, shape: S): void;
  bounds(shape: S): Bounds;
  /** Is `p` on (or within `slack` px of) the shape's ink? */
  hit(shape: S, p: Pt, slack?: number): boolean;
  translate(shape: S, dx: number, dy: number): S;
}

export interface PointerInfo {
  /** Shift was held. */
  shift: boolean;
  /** All pointer samples since the last event, in canvas coordinates (fast strokes deliver several). */
  samples: Pt[];
}

/** What a tool does with the mouse while the page is frozen. */
export interface ToolBehavior {
  cursor?: string;
  /** Do not let the browser move focus away on press (the text tool needs this). */
  keepFocus?: boolean;
  pointerDown?(ctx: ToolContext, p: Pt, info: PointerInfo): void;
  pointerMove?(ctx: ToolContext, p: Pt, info: PointerInfo): void;
  pointerUp?(ctx: ToolContext): void;
}

export interface ToolContext {
  readonly color: string;
  readonly width: number;
  readonly shapes: { get(kind: string): ShapeKind | undefined };
  readonly history: import("./ink/history").History;
  /** The shape being drawn right now (drawn on top of the others). */
  draft: Shape | null;
  readonly selectedId: number | null;
  /** Where the text box is open now, if it is. */
  readonly textAt: Pt | null;
  select(id: number | null): void;
  /** Ask the UI for a text box at `at` (null closes it). */
  requestText(at: Pt | null): void;
  newId(): number;
  pick(p: Pt): Shape | null;
  /** Repaint the canvas. */
  render(): void;
  /** Tell the UI the ink changed (undo/redo availability, count). */
  changed(): void;
}

export interface ToolDef extends Entry {
  label: string;
  /** Short label under the icon. Defaults to the first word of `label`. */
  short?: string;
  /** Shortcut key (a single character); registered automatically. */
  key?: string;
  /** What to show as the shortcut in tooltips. Defaults to `key` upper-cased. */
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  /** Absent for tools that are modes rather than drawing tools ("live"). */
  behavior?: ToolBehavior;
}
