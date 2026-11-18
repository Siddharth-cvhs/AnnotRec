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
node test/panel.mjs        # side panel smoke test
node test/pause.mjs        # pause/resume cuts the paused time (6 checks)
node test/tools.mjs        # every drawing tool, undo/redo, eraser, shortcuts (16 checks)
```
They launch their own Edge and server on spare ports and clean up after themselves.

## Files
`src/background.js` (service worker), `src/offscreen.js` (recorder), `src/content.js` (overlay and drawing), `src/sidepanel.*` (toolbar).

## Drawing tools
Pen (B), Highlighter (H), Line (L), Arrow (A), Box (R), Circle (O), Text (T), Numbered marker (M), Eraser (E). Shift snaps lines and arrows to 45 degrees. Ctrl+Z / Ctrl+Shift+Z undo and redo, Esc clears everything and goes live. Colours and size are in the side panel.
