# AnnotRec browser extension: spike (Version 3)

A Manifest V3 extension for **Microsoft Edge**. Record the page you are looking at, switch tabs while recording, freeze and draw on any page, Clear All to go live again, and get one MP4 made by our own FFmpeg server (Version 2). Details and findings: `../NOTES.md` section 18.

## Run it
1. Start the Version 2 server with the extension allowed (id is fixed by `key.json`):
   ```powershell
   cd ..\..\react-and-node
   $env:ANNOTREC_ALLOWED_ORIGINS = "chrome-extension://kbgonanciofpceomfnheeabchhcjnjbb"
   npm start
   ```
   FFmpeg must be installed.
2. Build: `node build.mjs` (writes `dist/`).
3. Open `edge://extensions`, turn on Developer mode, **Load unpacked**, choose `dist`.
4. Click the extension icon to open the side panel: **Share window** (once), **Allow microphone** (once), **Start**.

## Tests
```powershell
npm run ext:test           # everything, one after another, with a summary (about 5 minutes)
node extension/spike/test/all.mjs --soak=90   # the same plus a 90 s endurance recording
```
Each suite launches its own Edge and server on spare ports and cleans up after itself. They can also be run one by one (`node test/<name>.mjs`):

| Suite | Checks |
|---|---|
| `static` | manifest, least-privilege permissions, icons, no eval or external addresses, only the public key |
| `tools` | every drawing tool, undo/redo, select/move, eraser, shortcuts |
| `latency` | freeze time, smoothness with 400 shapes |
| `panel` | side panel, permission flow, saved-folder line |
| `hardening` | server down, share ended mid-recording, unsafe server address, restricted pages |
| `e2e` | the whole flow with pixel and sound checks on the MP4 |
| `robustness` | zoom and window resize while recording |
| `pause` | pause/resume cuts the paused time |
| `perf` | frame rate and CPU while recording |
| `demo` | shortcuts, badge, clock, level meter, navigating mid-recording (+ optional soak) |
| `autoreload` | a rebuild is picked up by itself, never during a recording |

## Drawing tools
Select and move (V, Delete removes), Pen (B), Highlighter (H), Line (L), Arrow (A), Box (R), Circle (O), Text (T), Numbered marker (M), Eraser (E). Shift snaps lines and arrows to 45 degrees. Ctrl+Z / Ctrl+Shift+Z undo and redo, Esc clears everything and goes live. Colours and size are in the side panel.

## Permissions
- **Allow microphone** (or Start, when it is not allowed yet) opens a small AnnotRec tab so the browser shows its microphone prompt. Choose Allow once.
- If it is refused, the tab says `Microphone: Permission denied` and shows the steps plus two buttons: **Edge microphone settings** (`edge://settings/content/microphone`) and **Windows microphone settings** (`ms-settings:privacy-microphone`).
- **Start** also opens the window picker by itself when the window is not shared yet, and explains what to do if it is cancelled.

## Where the videos are saved
In the folder of the server that makes the MP4: by default `recordings` inside the repo (`react-and-node/recordings`), or the folder in the `REC_DIR` environment variable. The side panel shows the exact path under **Saved videos**, with **Open folder**, **Copy path** and a **Show** button for each file.

## Demo mode: shortcuts and feedback
- **Alt+Shift+R** start / stop, **Alt+Shift+P** pause / resume, **Alt+Shift+D** freeze the page to draw / go live. They work from any page, so you never have to click the side panel while presenting. Change them at `edge://extensions/shortcuts`. If something is not ready (window not shared, microphone not allowed), the side panel opens and explains.
- The toolbar icon shows **REC** while recording, **II** when paused and **!** when a shortcut could not run.
- The side panel shows a big clock, a Recording / Paused state and a microphone level meter, and a green "Saved" line with a **Show** button when you stop.
- Drawing is smooth: freehand lines are curves (no corners), finished shapes are cached so a page with hundreds of shapes still draws at 60 fps, and freezing takes about 10 ms.

## After you change the code
`npm run ext:build` (or `node extension/spike/build.mjs`) rewrites `dist/`. An extension that is already loaded **reloads itself** within a few seconds of the next click in the side panel, and never while a recording is running. You do not touch `edge://extensions`. Only two things reset: the window share (pick the window again) and any frozen drawing. The microphone permission and your settings stay. (A pre-v3.0.0 build has no self-reload: reload it once by hand.)

## Safety and resilience
- Recordings are sent only to a server on this computer (`localhost` or `127.0.0.1`); any other address is refused.
- Permissions: `offscreen`, `sidePanel`, `storage`, `tabs`, `scripting`, and page access to draw on sites. No capture permission, nothing exposed to websites.
- Start checks the server and FFmpeg first and says what is wrong in plain words. Pieces of the recording are retried if the server hiccups. If you press "Stop sharing" in the middle of a recording, it is saved, not lost, and the panel tells you why it stopped.
- Browser pages (`edge://`, the extension store) cannot be drawn on; the panel says so.
