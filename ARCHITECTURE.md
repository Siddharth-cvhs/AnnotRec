# AnnotRec 2.0: architecture

The goal of this structure: **add a feature by adding a file, not by editing the
core**, and **embed the whole thing in another app** (client and server) without
forking it.

```
 ┌──────────────────────────── CLIENT (client/src) ─────────────────────────────┐
 │                                                                              │
 │  features/    recording  annotation  screenshot  library  viewport  dialogs  │
 │  (plugins)    chrome                    + YOUR plugins (examples/notes.tsx)  │
 │      │ register into                         ▲ listen to                     │
 │      ▼                                       │                               │
 │  ┌─────────── core/ (no React, no browser APIs) ────────────┐                │
 │  │ Registries: commands · shortcuts · tools · shapes ·      │   ui/          │
 │  │             panels · modals · sinks                      │   Shell + Slot │
 │  │ Services:   recording · annotation · capture · viewport  │   renders the  │
 │  │             library · settings · notifier · backend · ui │   registries   │
 │  │ Event bus (typed)        Kernel.run(command)             │                │
 │  └───────────────┬──────────────────────────────────────────┘                │
 │                  │ only through PORTS (interfaces)                           │
 │                  ▼                                                           │
 │  adapters/  browser (tab capture, MediaRecorder) · http (the server)         │
 │             storage (localStorage)         ← replace any of them             │
 └──────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTP  (apiBase = "" or "/tools/annotrec")
 ┌───────────────────────────── SERVER (server/src) ────────────────────────────┐
 │  createAnnotRec(options) → { router, events, startProxy, close }             │
 │  routes/ core · library · live      services: live sessions, targets, proxy  │
 │  PORTS: storage (files)   converter (FFmpeg)        EVENTS: recording:saved… │
 │  PLUGINS: (ctx) => { add routes, listen to events }                          │
 └──────────────────────────────────────────────────────────────────────────────┘
```

## The rules (what keeps it loosely coupled)

1. **`core/` imports nothing from `features/`, `ui/` or `adapters/`.** It is
   plain TypeScript: it runs (and can be tested) without React or a browser's
   capture APIs.
2. **The core reaches the outside world only through ports** (`core/ports.ts`):
   capture, clip recorder, library, viewport, backend, key-value storage, and the
   recording sinks. Adapters implement them. Swap one and nothing else changes.
3. **Features never import each other.** They talk through the kernel: call a
   command (`kernel.run("annotation.undo")`), read a service's store, or react to
   an event (`kernel.bus.on("recording:saved", …)`). For example the library
   shows the "Saved" toast by listening to the recording service's event; the
   recording service has never heard of the library.
4. **The UI shell has no features in it.** `Shell` is a layout of named slots;
   every card, button and layer is a panel a feature registered. A plugin can
   render its own `<Slot name="…"/>` and so let others extend it.
5. **Built-in features use the public plugin API** (they are in `features/`, and
   `create.ts` installs them like any other plugin). There is no back door.
6. **A failing plugin is contained**: a plugin whose `setup` throws shows a toast
   and is skipped; a panel that throws while rendering is dropped and logged.

## Extension points (client)

| You want to add… | Register in | Example |
|---|---|---|
| a button / card / layer | `kernel.panels` (`slot: "sidebar" \| "record.actions" \| "stage.layer" \| "topbar.right" …`) | `examples/notes.tsx` |
| something that can be done | `kernel.commands` | `notes.add` |
| a key chord | `kernel.shortcuts` (`when`, `priority`) | `ctrl+shift+n` |
| an annotation tool | `kernel.tools` (gets its button and, with `key`, its shortcut automatically) | the check-mark tool |
| a kind of drawing | `kernel.shapes` (`draw`, `bounds`, `hit`, `translate`) | `stamp` |
| a dialog | `kernel.modals`, opened with `services.ui.open(id)` | the player |
| a place to send recordings | `kernel.sinks` | `downloadSink` |
| your own settings | `services.settings.namespace("my-plugin")` | notes |
| a reaction to something | `kernel.bus.on("recording:saved" \| "screenshot:saved" \| "annotation:frozen" …)` | notes log |

A complete plugin:

```tsx
import { AnnotRec, type Plugin } from "annotrec-client"; // client/src/index.ts

const hello: Plugin = {
  id: "hello",
  setup(k) {
    const off = [
      k.commands.add({ id: "hello.say", run: () => k.services.notifier.info("Hello!") }),
      k.shortcuts.add({ id: "hello.say", keys: "ctrl+shift+h", command: "hello.say" }),
      k.bus.on("recording:started", () => k.services.notifier.info("Recording…")),
    ];
    return () => off.forEach((f) => f()); // optional cleanup
  },
};

<AnnotRec apiBase="/tools/annotrec" plugins={[hello]} exclude={["screenshot"]} />;
```

Everything is also reachable **without any UI**: `createAnnotRec()` returns the
kernel, and `kernel.run("recording.start")`, `kernel.services.*` and the event bus
are the public API (the test suite drives a whole recording this way).

## Extension points (server)

```js
import { createAnnotRec } from "./server/src/annotrec.js";

const annotrec = createAnnotRec({
  recDir: "./videos",                 // or storage: myStorage (S3, a database…)
  converter: myConverter,             // default FFmpeg; any { qualities, available(), start() }
  proxyPort: 4101,
  guard: false,                       // inside an app that has its own auth
  plugins: [
    (ctx) => {
      ctx.router.get("/api/hello", (req, res) => res.json({ hi: true }));
      ctx.events.on("recording:saved", (file) => upload(file.path));
    },
  ],
});
app.use("/tools/annotrec", annotrec.router);   // mount anywhere
await annotrec.startProxy();
```

Events: `recording:saved`, `screenshot:saved`, `file:removed`, `target:changed`.
The router never leaks outside its mount path. The built client uses relative
asset URLs and works out its `apiBase` from where it was loaded, so the same
build can be served at `/` or at `/tools/annotrec/`.

## Where things are

```
client/src/
  core/            kernel, registries, store, event bus, shortcuts, ports, contracts
    services/      recording, annotation, capture, viewport, library, settings, notifier, backend, ui
    ink/           the annotation engine (shapes, history, pointer dispatch), no UI
  adapters/        browser.ts (capture + recorder) · http.ts (server) · storage.ts
  features/        one folder per feature, each exporting a Plugin
  ui/              Shell, Slot, Viewport, Modal, React hooks (useKernel/useStore/useRegistry)
  examples/        notes.tsx: a plugin + a custom sink, using only the public API
  create.ts        assembles ports + built-in features + your plugins
  AnnotRec.tsx     the React component · index.ts the library entry · main.tsx the app · host.tsx an embedding example
server/src/
  annotrec.js      the factory · options.js · guard.js · live.js · proxy.js · targets.js
  storage.js       the storage port + default · converter.js the converter port + FFmpeg
  routes/          core.js · library.js · live.js
```

## Tests that hold the promises

`node scripts/scenarios.mjs` includes, besides the behaviour tests:

* **S13** a fake converter and a spying storage replace FFmpeg and the file layout;
  recordings flow through unchanged, and a server plugin hears the events.
* **P01** the server router mounted at `/tools/annotrec` inside another Express app
  (with a server plugin adding a route); the real app records through it.
* **P02** a plugin adds a tool, shape, command, shortcut, panel, button and event
  reaction, with persisted state, without touching the core.
* **P03** a custom sink saves recordings in the browser, with no server.
* **P04** a built-in feature is excluded.
* **P05** a plugin that crashes (at start-up and while rendering) is contained.
* **P06** the whole app is driven through commands, with no clicks.
