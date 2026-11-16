# AnnotRec 2.0 (React + Node)

> **Version 2 (this branch, `version-2`, tag `v2.0.0`): the React + Node web app.**
> **Version 1 (branch [`main`](../../tree/main), the default, tag `v1.0.0`)** is the Windows
> desktop app (Tauri + Rust). Get it with `git checkout main`.

Version 2 of AnnotRec: the same idea as Version 1 (the desktop app), rebuilt as a
**web app you serve on a local port**. No exe, so you can change anything. Show a
live page in a viewport, record it with your microphone, draw on it while you talk,
freeze it while you explain, and download **one MP4**.

## Run it

You need Node 20+ and FFmpeg on your PATH (or set `FFMPEG_PATH`). Use
**Microsoft Edge or Chrome 104+**.

```bash
npm run setup      # installs the server and the client (once)
npm run build      # builds the React app
npm start          # serves everything on http://localhost:4000
```

Open **http://localhost:4000**. For development with hot reload:

```bash
npm run dev        # API on :4000, React dev server on http://localhost:5173
```

Ports can be changed with `PORT` (default 4000) and `PROXY_PORT` (default
`PORT + 1`). Recordings go to `recordings/` (or `REC_DIR`).

## Using it

1. Type your app's address (e.g. `localhost:3000`) and press Go. The built-in
   sample page shows until you do. Pick a viewport size if you like.
2. **Start** (`R`). Choose **This tab** when your browser asks (once per
   session). After a 3-second countdown, only the viewport is recorded, never
   the panel or the address bar.
3. Talk and use the page normally, then pick a drawing tool: the page
   **freezes** (recording and microphone keep going) and you draw. **Clear all**
   (`Esc`) removes the ink and gives you the live page back.
4. Pause / Resume (`Space`), mic on/off (`Shift+M`), Screenshot (`S`) at any
   time. **Stop** (`Shift+R`) and the MP4 is ready almost at once. Play it,
   download it, or show it in its folder from the "Saved" list.

**Tools:** select/move (`V`), pen (`B`), pencil (`N`), highlighter (`H`), line
(`L`), arrow (`A`), rectangle (`U`), circle (`O`), text (`T`), numbered marker
(`M`), eraser (`E`); hold **Shift** while drawing for straight lines and
squares/circles; `Ctrl+Z` / `Ctrl+Y` undo and redo; `Delete` removes the
selected shape; colours, a custom colour and stroke size. Press `?` in the app
for the full list. Shortcuts work when the app page has focus: click outside the
viewport first if you were using the page.

Settings (countdown, video quality, microphone default) are remembered in the
browser.

## How it works

```
 Browser (React)                                       Node server
 ┌─────────────────────────────────┐  WebM pieces     ┌───────────────────────┐
 │ viewport <div> ← iframe         │ ───────────────▶ │ FFmpeg converts as it │
 │   + overlay canvas (ink)        │  while recording │ arrives → MP4         │
 │ panel, address bar              │ ◀──── /api ───── │ Express API           │
 └────────────────┬────────────────┘                  │ viewport proxy :4001  │
  tab capture + cropTo(viewport)                      │ (strips frame blocks) │
  MediaRecorder (+ microphone)                        └───────────────────────┘
```

* **Capture.** `getDisplayMedia` on the current tab records the page as it is on
  screen (the iframe, the frozen picture and the ink). **Region Capture**
  (`CropTarget` / `cropTo`) cuts the stream to the viewport element, and exact
  size constraints make it pixel-for-pixel the viewport (no scaling). `MediaRecorder`
  records that plus the microphone.
* **Freeze without pausing** (`useApp.ts`, `Overlay.tsx`). Choosing a tool grabs
  the newest frame of the same stream straight from memory (a few milliseconds),
  paints it on a canvas over the iframe and lets the drawing canvas take the
  mouse. The recorder is never touched, so the video shows the frozen page and the
  ink appearing while your voice continues.
* **Live conversion** (`server/index.js`, `api.ts`). While recording, the WebM
  goes to the server in one-second pieces and FFmpeg encodes them as they
  arrive, so pressing Stop only finishes the last piece (about 0.3-1 s however
  long the recording is). The browser keeps every piece; if anything on that
  path fails it uploads the whole recording instead.
* **Viewport proxy** (`server/proxy.js`). Many apps refuse to be shown in an
  iframe. A small reverse proxy on its own port forwards to your app and removes
  `X-Frame-Options` / CSP `frame-ancestors`. A port of its own keeps
  root-relative URLs and WebSockets (hot reload) working. It listens on
  `127.0.0.1` only.
* **Safety.** The server answers only requests whose Host and Origin are this
  machine (no DNS-rebinding, no other websites), accepts only http(s)
  addresses, only touches files with plain `.mp4`/`.png` names inside the
  recordings folder, and kills an abandoned conversion after 90 s.

## Structure (loosely coupled, built to be extended)

Read **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full picture. In short:

* **Client** (`client/src`): a framework-free **core** (services, registries, event bus) that only
  talks to the world through **ports**; **adapters** implement them for the browser and the
  server; every feature is a **plugin** that registers commands, shortcuts, tools, shapes,
  panels, dialogs or recording destinations; the React **shell** just renders slots.
  A new feature is a new file (see `client/src/examples/notes.tsx`), not an edit to the core.
* **Server** (`server/src`): `createAnnotRec(options)` returns a router you can mount under any
  path in another Express app, with swappable storage and converter ports, events and server plugins.
* Embed it: `<AnnotRec apiBase="/tools/annotrec" plugins={[myPlugin]} />` (client) and
  `app.use("/tools/annotrec", createAnnotRec({...}).router)` (server). `/host.html` is a working
  example of a host page with an extra plugin and an extra recording destination.

| Path | Role |
|---|---|
| `server/index.js` | standalone entry: the router and the built app on one port |
| `server/src/annotrec.js` | the server factory (ports, events, plugins) |
| `server/src/routes/` | core (health, target), library (files), live (conversion while recording) |
| `client/src/core/` | kernel, registries, services, ink engine, ports, contracts |
| `client/src/features/` | recording, annotation, screenshot, library, viewport, dialogs, chrome |
| `client/src/adapters/` | browser capture + recorder, HTTP, storage |
| `client/src/ui/` | shell, slots, viewport, hooks |
| `scripts/scenarios.mjs` | the scenario suite (below) |
| `scripts/perf.mjs` | performance measurements |
| `scripts/e2e.mjs`, `scripts/shots.mjs` | quick end-to-end run; screenshots of every UI state |

## Tests

```bash
npm run setup
node scripts/scenarios.mjs            # 45 scenarios, ~8 minutes
node scripts/scenarios.mjs --long     # 46: adds a 60 s endurance recording
node scripts/scenarios.mjs --only=S05,U05
node scripts/perf.mjs                 # measurements
```

The suite starts its own server and a test app that refuses to be framed, and
drives real visible Microsoft Edge windows (no clicking needed: Edge flags
auto-accept "share this tab" and supply a fake microphone). Every recording is
analysed pixel by pixel with FFmpeg: ink must be in the video exactly while the
page is frozen, at the right place at 1.5x display scaling; the video must be
exactly the viewport; audio and video lengths must match; a pause must be cut
out. It also covers the API and security checks, the proxy (redirects,
root-relative assets, a dead target), error paths (no microphone, cancelled
share, "Stop sharing", closing the tab, FFmpeg cancelled mid-conversion),
keyboard shortcuts, settings, the library, and accessibility basics. A group of
scenarios proves the architecture's promises: swapped server ports, the router mounted inside
another Express app, a plugin extending the app without touching the core, a custom recording
destination, excluded features, a crashing plugin, and driving the app purely through commands.

## Performance (measured on the development machine)

| What | Result |
|---|---|
| First paint / app code | ~0.5 s / 88 KB gzipped |
| Tool click to frozen page | ~65 ms |
| Drawing | 60 fps, no long tasks, also while recording |
| DOM activity while recording | ~34 writes per second (timer and mic meter) |
| Stop to saved MP4 | ~0.3-1 s regardless of length |
| MP4 conversion speed | ~10x faster than real time |

## Limits

* Chromium browsers only (Edge, Chrome): Region Capture is not in Firefox or
  Safari. Open it at `http://localhost`/`127.0.0.1` (a secure context), not over
  a LAN address.
* You approve "share this tab" once per browser session. Very occasionally
  the browser starts a capture without delivering any picture: the app retries
  once, then asks you to try again with the tab in front.
* The proxy handles typical dev apps. Sites with strict single sign-on, cookies
  tied to their own domain, or anti-framing scripts may not work inside it. The
  proxy shows one page at a time, so use one browser tab of the app.
* Keep the browser tab visible while recording; a hidden or covered tab can stop
  delivering frames.
* The viewport size is locked while recording.
* No captions and no system (speaker) audio yet.
* Nothing leaves your machine.
