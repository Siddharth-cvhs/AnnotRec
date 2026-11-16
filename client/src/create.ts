import { BrowserCapture, BrowserClip } from "./adapters/browser";
import { createServerSink, HttpBackend, HttpLibrary, HttpViewport } from "./adapters/http";
import { localStorageKV } from "./adapters/storage";
import type { Plugin } from "./core/contracts";
import { createKernel, type Kernel } from "./core/kernel";
import type { Ports, RecordingSink } from "./core/ports";
import { annotationPlugin } from "./features/annotation";
import { chromePlugin } from "./features/chrome";
import { dialogsPlugin } from "./features/dialogs";
import { libraryPlugin } from "./features/library";
import { recordingPlugin } from "./features/recording";
import { screenshotPlugin } from "./features/screenshot";
import { viewportPlugin } from "./features/viewport";

/** The features that ship with AnnotRec, in install order. They use the same plugin API as yours. */
export const builtInPlugins: Plugin[] = [
  chromePlugin,
  viewportPlugin,
  recordingPlugin,
  annotationPlugin,
  screenshotPlugin,
  libraryPlugin,
  dialogsPlugin,
];

export interface AnnotRecOptions {
  /** Where the server router is mounted: "" (the site root, default) or e.g. "/tools/annotrec". */
  apiBase?: string;
  /** Replace any of the ports (capture, clip, library, viewport, backend, storage): see core/ports.ts. */
  ports?: Partial<Ports>;
  /** Your features, installed after the built-in ones. */
  plugins?: Plugin[];
  /** Built-in feature ids to leave out, e.g. ["screenshot"]. */
  exclude?: string[];
  /** Where recordings can go. Default: the AnnotRec server. */
  sinks?: RecordingSink[];
}

/**
 * Builds a ready kernel: ports (browser + HTTP by default), the built-in
 * features, then yours. Render it with <AnnotRec kernel={...}/>, or drive it
 * with no UI at all (kernel.run("recording.start")).
 */
export function createAnnotRec(options: AnnotRecOptions = {}): Kernel {
  const base = (options.apiBase ?? "").replace(/\/$/, "");
  const ports: Ports = {
    capture: new BrowserCapture(),
    clip: new BrowserClip(),
    library: new HttpLibrary(base),
    viewport: new HttpViewport(base),
    backend: new HttpBackend(base),
    storage: localStorageKV,
    ...options.ports,
  };
  const kernel = createKernel(ports);
  for (const sink of options.sinks ?? [createServerSink(base)]) kernel.sinks.add(sink);
  const excluded = new Set(options.exclude ?? []);
  for (const plugin of builtInPlugins) if (!excluded.has(plugin.id)) kernel.use(plugin);
  for (const plugin of options.plugins ?? []) kernel.use(plugin);
  return kernel;
}
