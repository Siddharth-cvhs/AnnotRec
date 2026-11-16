import type { Command, ModalDef, PanelDef, Plugin, Shortcut, ShapeKind, ToolDef } from "./contracts";
import { Emitter } from "./emitter";
import type { AppEvents } from "./events";
import type { Ports, RecordingSink } from "./ports";
import { Registry } from "./registry";
import { AnnotationService } from "./services/annotation";
import { BackendService } from "./services/backend";
import { CaptureService } from "./services/capture";
import { LibraryService } from "./services/library";
import { NotifierService } from "./services/notifier";
import { RecordingService } from "./services/recording";
import { SettingsService } from "./services/settings";
import { UiService } from "./services/ui";
import { ViewportService } from "./services/viewport";
import { ShortcutManager } from "./shortcuts";

export interface Services {
  settings: SettingsService;
  notifier: NotifierService;
  backend: BackendService;
  capture: CaptureService;
  viewport: ViewportService;
  recording: RecordingService;
  annotation: AnnotationService;
  library: LibraryService;
  ui: UiService;
}

/**
 * The kernel: services, registries and the event bus, wired together. It has
 * no features of its own (no tools, no panels, no commands): those all come
 * from plugins. See contracts.ts for what a plugin can add.
 */
export interface Kernel {
  readonly bus: Emitter<AppEvents>;
  readonly ports: Ports;
  readonly services: Services;

  readonly commands: Registry<Command>;
  readonly shortcuts: Registry<Shortcut>;
  readonly tools: Registry<ToolDef>;
  readonly shapes: Registry<ShapeKind>;
  readonly panels: Registry<PanelDef>;
  readonly modals: Registry<ModalDef>;
  readonly sinks: Registry<RecordingSink & { id: string }>;

  /** Run a command by id. Failures become an error toast, never an exception. */
  run(id: string, args?: unknown): Promise<void>;
  /** Install a plugin (once per id). */
  use(plugin: Plugin): void;
  /** Start listening for key presses; returns the stop function. */
  attachKeyboard(target?: Window): () => void;
  /** Load things that need the server (call once the UI is ready). */
  start(): Promise<void>;
  dispose(): void;
}

export function createKernel(ports: Ports, plugins: Plugin[] = []): Kernel {
  const bus = new Emitter<AppEvents>();
  const commands = new Registry<Command>();
  const shortcuts = new Registry<Shortcut>();
  const tools = new Registry<ToolDef>();
  const shapes = new Registry<ShapeKind>();
  const panels = new Registry<PanelDef>();
  const modals = new Registry<ModalDef>();
  const sinks = new Registry<RecordingSink & { id: string }>();

  const settings = new SettingsService(ports.storage);
  const notifier = new NotifierService();
  const backend = new BackendService(ports.backend, notifier);
  const viewport = new ViewportService(ports.viewport, settings, notifier, bus);
  const capture = new CaptureService(ports.capture, () => viewport.element, bus);
  const library = new LibraryService(ports.library, notifier);
  const recording = new RecordingService({ capture, clip: ports.clip, viewport, settings, notifier, sinks, bus });
  const annotation = new AnnotationService({ capture, settings, notifier, tools, shapes, bus });
  const ui = new UiService();

  const installed = new Map<string, void | (() => void)>();
  let started: Promise<void> | null = null;

  const kernel: Kernel = {
    bus,
    ports,
    services: { settings, notifier, backend, capture, viewport, recording, annotation, library, ui },
    commands,
    shortcuts,
    tools,
    shapes,
    panels,
    modals,
    sinks,

    async run(id, args) {
      const command = commands.get(id);
      if (!command) return notifier.error(new Error(`Unknown command "${id}".`));
      if (command.enabled && !command.enabled(kernel)) return;
      try {
        await command.run(kernel, args);
      } catch (e) {
        notifier.error(e);
      }
    },

    use(plugin) {
      if (installed.has(plugin.id)) return;
      installed.set(plugin.id, undefined);
      try {
        installed.set(plugin.id, plugin.setup(kernel));
      } catch (e) {
        // One broken plugin must not take the app down.
        console.error(`[annotrec] plugin "${plugin.id}" failed to start`, e);
        notifier.error(new Error(`The "${plugin.id}" feature failed to start: ${(e as Error).message}`));
      }
    },

    attachKeyboard: (target) => new ShortcutManager(kernel).attach(target),

    start() {
      // Once: React may mount twice in development.
      started ??= Promise.all([backend.init(), viewport.init(), library.refresh()]).then(() => undefined);
      return started;
    },

    dispose() {
      for (const cleanup of installed.values()) if (typeof cleanup === "function") cleanup();
      installed.clear();
      bus.clear();
    },
  };

  plugins.forEach((p) => kernel.use(p));
  return kernel;
}
