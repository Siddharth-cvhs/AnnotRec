// The AnnotRec client as a library.
//
//   import { AnnotRec } from "annotrec-client";
//   <AnnotRec apiBase="/tools/annotrec" plugins={[myPlugin]} />
//
// See ARCHITECTURE.md for the extension points.

export { AnnotRec, type AnnotRecProps } from "./AnnotRec";
export { createAnnotRec, builtInPlugins, type AnnotRecOptions } from "./create";

// Building blocks for plugins
export { createKernel, type Kernel, type Services } from "./core/kernel";
export type { AppEvents } from "./core/events";
export type {
  Bounds,
  Command,
  ModalDef,
  PanelDef,
  Plugin,
  PointerInfo,
  Shape,
  ShapeKind,
  Shortcut,
  SlotName,
  ToolBehavior,
  ToolContext,
  ToolDef,
} from "./core/contracts";
export type {
  BackendPort,
  CapturePort,
  ClipPort,
  KeyValueStore,
  LibraryPort,
  Ports,
  RecordingSink,
  SinkSession,
  ViewportPort,
} from "./core/ports";
export type { FileInfo, InkState, Phase, Pt, Quality, Saved, Settings, SizeMode, Toast } from "./core/types";
export { createStore, type Store } from "./core/store";
export { Registry, type Entry } from "./core/registry";
export { Emitter } from "./core/emitter";

// Adapters, if you want to reuse or wrap them
export { BrowserCapture, BrowserClip } from "./adapters/browser";
export { createServerSink, HttpBackend, HttpLibrary, HttpViewport } from "./adapters/http";
export { localStorageKV, memoryKV } from "./adapters/storage";

// React helpers for panels
export { KernelProvider, useKernel, useRegistry, useStore } from "./ui/context";
export { Slot } from "./ui/Slot";
export { Modal } from "./ui/Modal";

// Drawing helpers for custom tools and shapes
export { freehand, twoPoint } from "./features/annotation/tools";
export { markerSize, textSize } from "./features/annotation/shapes";
