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
node test/e2e.mjs          # full flow, 18 checks
node test/robustness.mjs   # zoom and resize
node test/panel.mjs        # side panel, permission flow, saved-folder line (12 checks)
node test/latency.mjs      # freeze time and drawing smoothness over 400 shapes
node test/demo.mjs         # a presenter's run: shortcuts, badge, clock, level meter, navigating mid-recording
node test/perf.mjs         # smoothness and CPU while recording a moving page
node test/shots.mjs        # regenerates the pictures in extension/docs
node test/pause.mjs        # pause/resume cuts the paused time (6 checks)
node test/tools.mjs        # every drawing tool, undo/redo, eraser, shortcuts (19 checks)
```
They launch their own Edge and server on spare ports and clean up after themselves.

## Files
`src/background.js` (service worker), `src/offscreen.js` (recorder), `src/content.js` (overlay and drawing), `src/sidepanel.*` (toolbar).

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
