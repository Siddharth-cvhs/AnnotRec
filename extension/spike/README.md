# AnnotRec browser extension (Version 3)

A Manifest V3 extension for **Microsoft Edge, Google Chrome and Brave** (any Chromium browser, version 116 or newer). Record the page you are looking at, switch tabs while recording, freeze and draw on any page, Clear All to go live again, and get one MP4 made by our own FFmpeg server (Version 2). Details and findings: `../NOTES.md` section 18.

## Run it
1. Start the Version 2 server with the extension allowed (id is fixed by `key.json`):
   ```powershell
   cd ..\..\react-and-node
   $env:ANNOTREC_ALLOWED_ORIGINS = "chrome-extension://kbgonanciofpceomfnheeabchhcjnjbb"
   npm start
   ```
   FFmpeg must be installed.
2. Build: `node build.mjs` (writes `dist/`).
3. Open the extensions page (`edge://extensions`, `chrome://extensions` or `brave://extensions`), turn on Developer mode, **Load unpacked**, choose `dist`.
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
- **Allow microphone** (or Start, when it is not allowed yet) makes the browser ask: a small AnnotRec tab opens and the browser shows its own permission prompt there. Choose Allow once.
- If the microphone is **blocked** (the browser cannot ask any more), the same button opens this extension's own site setting (`.../settings/content/siteDetails?site=chrome-extension://...`) by itself, so you change Microphone to Allow in one step. The panel notices the change at once.
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

## Browsers
| | Edge | Chrome | Brave |
|---|---|---|---|
| All extension and web APIs the recorder needs (`test/compat.mjs`) | yes | yes | yes |
| Full test suite (`BROWSER=<name> npm run ext:test`) | all pass | all pass | all pass |
| Same extension id everywhere (fixed by `key.json`) | yes | yes | yes |
| Self-reload after a rebuild | on by default | off by default (setting) | off by default (setting) |

Edge was the first target; Chrome and Brave run the same code. The only differences are the wording and the address of the browser's own settings page (`edge://`, `chrome://`, `brave://`), which the panel works out by itself, and the developer self-reload described below.

**Testing in another browser:** `BROWSER=chrome npm run ext:test` or `BROWSER=brave npm run ext:test`. Chrome 137 and later ignore `--load-extension`, so the tests install the extension there through the DevTools protocol.

**Self-reload is a developer convenience.** In Edge it is on by default (proven by `test/autoreload.mjs`). In Chrome and Brave it is a checkbox in the panel's Settings, off by default: the browsers' own tooling installs the extension in a way that does not come back after `chrome.runtime.reload()`, and when you install with **Load unpacked** I have not been able to confirm that in an automated test. If you want it, turn it on and see; if the extension ever vanishes, load it again and leave it off. Otherwise press the reload arrow on the extensions page after a rebuild.

## Speed
Measured on a 12-core laptop (`test/startlatency.mjs`, `test/ui.mjs`, `test/perf.mjs`, `test/latency.mjs`), with the browser's fake microphone:

| What | Before | Now |
|---|---|---|
| Press **Start** until it is recording | 1.25 s first time, 0.55 s later | **about 0.2 s first time, about 0.1 s later** (through the real panel: "Recording" 0.25 s after the click) |
| **Start** button feedback | none until done | **"Starting…" within 0.03 s** |
| Choose a drawing tool | 2 messages, slow to light | lights at once, page frozen in about 0.1 s |
| Press **Stop** | no feedback | "Saving…" at once, "Saved ✓" about 0.2 s later |
| Page picture to draw on | 10-300 ms | unchanged (Chrome: about 0.3 s, a browser limit) |
| Recording a moving page | about 8-10% of the machine | same, 30 fps |
| Recording a still page (most of a demo) | about 10% | **about 1.5%** |

**What made Start fast**
- The page is measured **once, when you share the window**, and reused (it is measured again only if the window or page size changes). So Start no longer flashes a magenta frame and no longer waits for it.
- The microphone and the server session open **at the same moment**, while the rest is checked, instead of one after another. The audio system is warmed up once when you share the window, because its first opening is the slowest.
- The server check is remembered for 30 s, and the server remembers that FFmpeg exists (it used to start FFmpeg on every check, about 0.2 s).
- The marker search reads two thin strips of the picture instead of all of it.

**With a real microphone** the opening of the device itself can still take a moment (a Bluetooth headset can take a second or more, and that is the headset, not the extension). The panel already shows "Starting…", and the work happens in parallel, so you only wait for the microphone itself.

Other numbers: at most five visible hitches (over 100 ms) in a whole recording, Stop under a second, drawing over 400 shapes keeps 60 fps, the side panel polls slowly (1.2 s) when nothing is recording and fast (0.3 s) only while recording.

## Look and feel
- **Instant, then smooth:** every press answers at once (the button changes, the tool lights up, "Starting…" and "Saving…" show), and every change of state is eased over about 0.15-0.25 s: the **Get ready** card folds away by itself when you are set up, **Start recording** cross-fades into **Pause / Stop / Mute**, the clock and recording dot pulse, the level meter glides, cards rise in when the panel opens, new videos pop into the list, messages slide in and out.
- **Clear:** one big primary button; icons with labels for the ten tools; a live preview of the chosen colour and size; the saved-videos list shows name, length, size and time with a **Show** button; an empty list explains what to do; every error is a plain sentence in one red box, never a stack trace.
- **Light and dark:** both follow the browser. People who ask their system for less motion get no animation.
- **On the page:** the pointer matches the tool (crosshair, I-beam for text, an arrow that turns into a move cross over a shape you can move), and the drawing fades out when you clear it.
- **Keyboard and screen readers:** every control has a label, messages are announced, focus is always visible, and the part of the panel that is out of sight cannot be reached by Tab.
- Pictures of every state (light and dark) are made by `node test/uxshots.mjs <folder>`.
