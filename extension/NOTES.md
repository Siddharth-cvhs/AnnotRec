# AnnotRec Version 3: the browser extension. Brainstorm and notes

Status: **planning notes, nothing built yet.** Written 2026-11-18.
Legend: ✅ verified on this machine today · ⚠ expected from how browsers work, **must be proven in the spike**.

---

## 1. What you asked for

A **Version 3** of AnnotRec that is **attached to the browser itself**, as an extension:

* works on **every website** and **across multiple tabs**: switch tabs and stay in control;
* the **same recording and toolbar** as Versions 1 and 2, on/off at will, in the browser you already use;
* **no separate viewport window and no proxy**;
* **local**: you run the codebase and it produces an extension you install yourself;
* for **Edge, Chrome and Brave**, and other browsers if possible;
* **more versatile**: room for a much bigger toolbar and many more features.

## 2. The short answer

**Yes, all of it is possible**, and it is a better fit than Version 2 in several ways. One build
(Chromium Manifest V3) covers Edge, Chrome, Brave and Opera. Firefox is possible later with a reduced
feature set. Safari is a separate project.

The honest costs: company policy for installing extensions, a one-time microphone grant, more
moving parts than a web app, and Chrome needs a different route for *automated* testing (details below).

## 3. Evidence gathered on this machine (2026-11-18)

Scripts are in `probes/` so you can re-run them.

### 3.1 Browsers installed here: a ready test matrix ✅

| Browser | Version found | Chromium-based |
|---|---|---|
| Microsoft Edge | 157 | yes |
| Google Chrome | 157 | yes |
| Brave | Chromium 157 | yes |
| Opera | 140 (Chromium 157) | yes |
| Firefox | not installed | no (Gecko) |

### 3.2 What each can record, directly ✅ (`probes/probe-recording.mjs`)

| | Edge | Chrome | Brave | Opera |
|---|---|---|---|---|
| `MediaRecorder` **MP4 (H.264 + AAC)** | yes | yes | yes | yes |
| WebM (VP9 + Opus) | yes | yes | yes | yes |
| Region Capture (`CropTarget`) | yes | yes | yes | yes |
| WebCodecs (`VideoEncoder` / `AudioEncoder`) | yes | yes | yes | yes |
| OPFS (private file storage) | yes | yes | yes | yes |
| `showSaveFilePicker` (Save As dialog) | yes | yes | **no** | yes |

**Consequence:** the browser can write the **MP4 itself**. Version 3 can drop FFmpeg and the Node
server entirely (they can stay as an *optional* extra). Brave has no Save As picker, so downloads
must go through the extension's `downloads` API there.

### 3.3 Which extension APIs exist ✅ (presence only; `probes/probe-extension-apis.mjs`)

A tiny test extension was loaded and asked what it can call:

| API (what we need it for) | Edge | Brave | Opera | Chrome |
|---|---|---|---|---|
| `tabCapture` (record a tab) | yes | yes | yes | not tested* |
| `offscreen` (a hidden page that records) | yes | yes | yes | not tested* |
| `sidePanel` (controls beside the page) | yes | yes | yes | not tested* |
| `scripting` (inject the drawing layer) | yes | yes | yes | not tested* |
| `commands` (keyboard shortcuts) | yes | yes | yes | not tested* |
| `downloads`, `storage`, `tabs.captureVisibleTab` | yes | yes | yes | not tested* |

\* **Chrome refused to load the test extension from the command line** (Chrome 137+ removed
`--load-extension` for normal builds). That affects only *automated* loading: a person can still use
"Load unpacked" in `chrome://extensions`. Chrome shares the Chromium engine with Edge and Brave, so
the APIs are expected to be there, but this is ⚠ until tried by hand. Automated Chrome tests need
another route (see 11).
**Only presence was checked.** Whether each API *behaves* correctly is what the spike proves.

## 4. Options considered

| # | Idea | Verdict |
|---|---|---|
| **A** | **Content script draws on the page + side panel holds the controls + a hidden offscreen page records the tab** | **Recommended.** Controls are outside the page, so tab capture never records them: the same "toolbar not in the video" property as Versions 1 and 2. |
| B | Put the whole toolbar inside the page | The toolbar would be recorded (Region Capture cannot crop for a stream the extension page owns). Only acceptable as an auto-hiding mini strip. |
| C | Popup only | A popup closes the moment you click the page. Fine for start/stop, useless for drawing tools. |
| D | Keep Version 2 and inject it into pages | Needs the iframe + proxy again: exactly what we want to get rid of. |
| E | Native companion app (native messaging) | Optional later: only for things a browser can't do (FFmpeg, real desktop capture). |
| F | One extension that also records the whole screen | Possible with `chrome.desktopCapture` (a picker), but annotation overlay only exists on web pages. Treat as an extra mode. |

## 5. The recommended architecture (Option A)

```
 ┌─────────────────────────── the browser ────────────────────────────┐
 │                                                                    │
 │  TAB (any website)              SIDE PANEL (our React UI)          │
 │  ┌──────────────────────┐       ┌───────────────────────┐          │
 │  │ the page             │       │ Record card, tools,   │          │
 │  │ + content script:    │◀─────▶│ library, settings     │          │
 │  │   overlay canvas     │ msgs  │ (reuses Version 2's   │          │
 │  │   frozen picture     │       │  features/*)          │          │
 │  │   ink engine         │       └──────────┬────────────┘          │
 │  └──────────▲───────────┘                  │ commands              │
 │             │ frames/ink                   ▼                       │
 │             │                    SERVICE WORKER (orchestrator)     │
 │   tab capture stream                │  per-tab state, shortcuts,   │
 │             │                       │  badge, permissions          │
 │  ┌──────────┴──────────────────────▼───────────────┐              │
 │  │ OFFSCREEN DOCUMENT (hidden page that survives)  │              │
 │  │  tab stream(s) + microphone (+ tab audio)       │              │
 │  │  → compositor canvas → MediaRecorder (MP4)      │              │
 │  │  → chunks written to OPFS → chrome.downloads    │              │
 │  └─────────────────────────────────────────────────┘              │
 └────────────────────────────────────────────────────────────────────┘
```

| Piece | Job | Why it has to be separate |
|---|---|---|
| **Content script** (per tab) | Draws the overlay canvas and the frozen picture, runs the ink engine (shapes, tools, undo) | It is the only code that can draw *on the page* |
| **Side panel** (React) | Shows the cards and buttons, holds the kernel and its plugin system | A UI that sits beside the page, never inside the recording |
| **Service worker** | Routes messages, remembers state per tab, handles shortcuts and the toolbar icon | It is the extension's entry point; it **sleeps after ~30 s idle**, so it must not hold the recording |
| **Offscreen document** | Holds the capture streams, the microphone and the recorder | Service workers cannot record; this hidden page lives as long as the media does |
| **Options / "Studio" page** (a full tab) | Large library, player, settings, later trimming | This is where "a large part of the toolbar" can grow, unconstrained by the narrow side panel |

### 5.1 Key flows

1. **Start:** click the icon or press a shortcut. That gesture grants access to the current tab (no
   "share this tab" dialog). The worker asks `tabCapture` for a stream id; the offscreen document
   opens it, adds the microphone, and starts the recorder.
2. **Freeze:** the content script gets a snapshot of the page (first choice
   `tabs.captureVisibleTab`, limited to ~2 calls per second, plenty for a freeze; alternative: a
   stream id consumed inside the tab), paints it over the page and switches to drawing mode. Recording
   never stops, so the video shows the frozen page and the ink appearing.
3. **Clear all / go live:** remove ink and picture, the page is interactive again.
4. **Stop:** the recorder finishes, the file is already in OPFS, and `chrome.downloads` saves it to
   `Downloads\AnnotRec\` (Brave: no Save As picker, downloads only).
5. **Switch tabs:** see section 6.

### 5.2 What we reuse from Version 2

The architecture refactor was done for exactly this. Reusable as is: the kernel, registries, event bus,
stores, the **ink engine, shapes and tools**, the services' logic (recording phases, timers,
annotation), and the React feature panels. New work: the **adapters** (tab capture + offscreen recorder
instead of `getDisplayMedia`; storage in OPFS/IndexedDB instead of the HTTP server; no viewport/proxy
adapter) and a **different shell** (side panel + content-script overlay instead of the page layout).
Plan: extract `core/` into a shared package used by Version 2 and Version 3.

## 6. "Switch between tabs and stay in control"

Tab capture records **one tab**. Three ways to handle switching, from simplest:

| Mode | Behaviour | How |
|---|---|---|
| **Lock to this tab** | The video stays on the tab you started on, even if you look elsewhere | One stream. Simplest, and what you get by default. |
| **Follow the active tab** ⚠ | One continuous video that always shows whatever tab you are on | The offscreen document holds a stream per tab and draws the active one into a **compositor canvas**; the recorder records the canvas + one continuous microphone track. Output size is fixed; other-sized tabs are scaled/letterboxed. Costs some CPU for the drawing. |
| **One recording per tab** | Separate files, one per tab | A recorder per stream. |

"Follow the active tab" is the feature that makes the extension clearly better than Version 2.
Annotation state is **per tab** (each tab's content script keeps its own ink), and the side panel
shows the state of whichever tab is active.

## 7. Drawing on every website: the hard parts ⚠

| Topic | Plan |
|---|---|
| Page CSS must not leak into our overlay | Put the overlay in a **Shadow DOM** |
| Overlay above everything, even fullscreen video | Use the browser's **top layer** (Popover API / `<dialog>`) so it stacks above a fullscreen element |
| Pages that navigate (reload, SPA route changes) | Re-inject on navigation; ink is lost on a real navigation (acceptable); keep the recording going |
| Iframes (including cross-origin) | The overlay sits on top in the top frame, so it covers them |
| Scrolling | While frozen, the picture is fixed, so scrolling isn't an issue; while live the overlay is click-through |
| Pages we can never touch | `chrome://` / `edge://` / `brave://`, the extension stores, some PDF viewers, `file://` unless the user allows file access. The icon shows "not available here" |
| Text selection / focus stealing | Same care as Version 2 (the overlay takes input only while frozen) |

## 8. Recording engine details

| Topic | Plan / gotcha |
|---|---|
| Tab video | `tabCapture.getMediaStreamId` → offscreen document → `getUserMedia({ chromeMediaSource: "tab" })` ⚠ |
| Microphone | `getUserMedia` needs a one-time permission granted from a **visible extension page** (offscreen documents cannot show the prompt). Plan: a first-run "Allow microphone" page. ⚠ |
| Tab's own sound (new feature) | Capturing a tab's audio **mutes it for you** unless it is played back; route it through Web Audio to the speakers and mix it with the microphone. ⚠ |
| Output format | `MediaRecorder` straight to **MP4 (H.264 + AAC)** ✅ supported in all four browsers. Possible weaknesses: variable frame rate and looser A/V timing than FFmpeg. If it matters: **WebCodecs + an MP4 muxer** for constant frame rate and exact timing (verified API present ✅) |
| Memory for long recordings | Stream chunks into **OPFS** while recording instead of holding them in RAM; bonus: **crash recovery** of an unfinished recording |
| Where files go | OPFS library inside the extension + `chrome.downloads` to `Downloads\AnnotRec\` |
| Pause / mic mute | Same ideas as Versions 1 and 2 |
| Service worker sleep | Recording lives in the offscreen document; the worker only coordinates |

## 9. The toolbar: how big can it get?

* **Side panel**: the main control surface, narrow but full-height; reuses Version 2's panels. Open
  from the icon or a shortcut. (`sidePanel.open` needs a user gesture.)
* **Studio page** (a normal tab): as large as you like: library, player, trimming, export, settings.
* **Keyboard shortcuts** (`commands`): start/stop, annotate on/off, clear. Browsers allow only about
  **four** suggested shortcuts per extension; the rest are in-page keys while annotating.
* **Toolbar icon**: a badge shows REC and the time; click toggles.
* **Optional in-page mini strip**: it would be recorded, so it should hide itself while recording.
* Browser differences: Edge, Brave and Opera also have their own sidebars; the panel behaves slightly
  differently in each, so test visually in all (✅ API exists in all three; behaviour ⚠).

## 10. Permissions, security and company policy

Your organisation's rules apply, and an extension that can draw on pages and use the microphone may
get review attention.

* **Minimum permissions:** `activeTab`, `scripting`, `tabCapture`, `offscreen`, `sidePanel`, `storage`,
  `downloads`. **No `<all_urls>`**: use "this site only" grants. Nothing leaves the machine (no
  network calls). MV3 forbids remotely hosted code anyway.
* **Managed browsers** can block "Load unpacked" or require an allow-list (`ExtensionInstallAllowlist`,
  developer-mode policies). Ask IT before relying on it. ⚠
* **Chrome shows a "developer mode extensions" notice** at start-up for unpacked extensions; a stable
  extension id (a `key` in the manifest) keeps your saved permissions.
* **Distribution later:** Edge Add-ons (free), Chrome Web Store (one-time developer fee), or a private
  or enterprise force-install. The same zip works for Edge, Chrome, Brave and Opera.
* **Privacy upsides:** a **blur / redact tool** on the drawing layer would help avoid recording
  sensitive screens: worth building given how much internal data appears on business pages.

## 11. How it would be installed and run (the "run the codebase" part)

Planned from-source flow (like Versions 1 and 2):

```bash
git clone -b version-3 https://github.com/Siddharth-cvhs/AnnotRec.git
cd AnnotRec
npm install
npm run build          # produces dist/  (the unpacked extension)
```

Then in each browser, turn on **Developer mode** and choose **Load unpacked**, pointing at `dist/`:

| Browser | Address |
|---|---|
| Edge | `edge://extensions` |
| Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Opera | `opera://extensions` |

`npm run dev` would rebuild on every change and reload the extension. `npm run pack` would zip it for a
store.

**Automated testing** (Playwright with a real browser, as for Version 2):
✅ Edge, Brave and Opera accepted the command-line loader today; ⚠ Chrome does not (Chrome 137+), so
Chrome would be tested by loading the extension through the browser's debugging protocol, or by hand.

## 12. Other browsers

| Browser | Verdict |
|---|---|
| Edge, Chrome, Brave, Opera, Vivaldi | **Same build.** (Vivaldi isn't installed here, so untested.) |
| Firefox | **Possible later, reduced**: no `tabCapture` and no offscreen documents, so it would record via `getDisplayMedia` (a picker each time) from an extension page, with its own sidebar API. MP4 output support in Firefox is ⚠ unknown. |
| Safari | Separate project (Xcode and an Apple developer account); capture APIs differ. Not planned. |

## 13. What the extension unlocks (ideas, not commitments)

* Annotate and copy a **screenshot of any page** without recording.
* **Follow the active tab** as one video (section 6) and region/area recording.
* **Webcam bubble**, cursor highlight and click ripples, a laser pointer, a spotlight.
* **Blur/redact** shapes; per-site auto-enable.
* **Studio**: trim, merge, GIF export, thumbnails, rename.
* **Captions** with a local Whisper (the earlier optional idea), and tab-audio capture.
* **DOM-aware annotations**: because the extension sees the page, each drawing could also save the
  URL, the element under it and its text next to the MP4. That brings back the original idea of
  giving a developer or an AI agent *precise* context. Optional, and out of scope unless you want it.

## 14. Risks and unknowns (each one is something the spike will settle)

| # | Risk | How we find out |
|---|---|---|
| 1 | Does one click give tab capture without a prompt in all four browsers? | Spike: icon → record |
| 2 | Microphone permission flow from an extension page, and in the offscreen document | Spike |
| 3 | MP4 from `MediaRecorder` in an extension: A/V sync, frame rate, seekability | Record a clip with a stopwatch on screen, analyse with FFmpeg as in the Version 2 tests |
| 4 | Freeze quality and speed via `captureVisibleTab` vs an in-tab stream | Measure both |
| 5 | Overlay above fullscreen video and inside weird pages | Try on video sites, docs, PDFs, SPAs |
| 6 | "Follow active tab" compositor: CPU, sync, resolution changes | Prototype after the basic spike |
| 7 | Side panel behaviour in Edge, Brave and Opera | Look at all of them |
| 8 | Managed-browser policy blocking unpacked extensions | Ask IT / test on your work profile |
| 9 | Service worker restarts losing state | Keep state in the offscreen document and `storage.session` |
| 10 | Chrome automation | CDP loading or manual checklist |

## 15. Phased plan

| Phase | Goal | Done when |
|---|---|---|
| **A. Spike** | Prove the risky 80%: icon → side panel → record tab + mic → freeze + draw over a real site → stop → **MP4 saved**, in Edge, Brave and Opera, then Chrome by hand | A real MP4 of a real website, with ink and voice |
| **B. Port** | Bring the core, ink engine and feature panels over; per-tab state; shortcuts; badge | Same feature set as Version 2 |
| **C. Multi-tab** | Lock / follow / per-tab modes | One video across several tabs |
| **D. Library** | OPFS storage, crash recovery, Studio page | Long recordings are safe |
| **E. Hardening** | Playwright suite per browser, permission minimisation, accessibility | A test run like Version 2's |
| **F. Ship** | Zip, README, stores or enterprise install | Installable by others |
| **G. Extras** | Whatever from section 13 you choose | |

Repo plan: a **`version-3` branch**, tag `v3.0.0`, with the shared `core/` extracted so Versions 2 and
3 do not drift apart. The three versions in one repo: `main` = Version 1 (desktop), `version-2` = web
app, `version-3` = extension.

## 16. Decisions needed from you

1. **Must-have browsers:** Edge, Chrome, Brave (plus Opera for free). Firefox later, or never?
2. **Tab switching:** is "follow the active tab" a must-have, or is "lock to this tab" enough for v3.0?
3. **Output:** browser-made MP4 only (no server), or keep an optional FFmpeg path for cleaner files?
4. **Permissions:** "current tab on click" (safest, a click per tab) or "always on for chosen sites"?
5. **Audio:** is recording the tab's own sound wanted?
6. **Where it lives:** your own GitHub only, or also a store later?
7. **IT check:** can you install unpacked extensions on your work browser profile?

## 17. Recommendation

Start with **Phase A, the spike**, in the `extension/` folder, on Edge first, then Brave, Opera and
Chrome. It answers risks 1 to 5 and 7 quickly and decides whether the browser-only MP4 is good enough
to drop the server. Everything after that is porting code we already have and tests.

---

## 18. Spike results (built and tested, 2026-11-18)

The spike lives in `extension/spike` (plain-JS Manifest V3, Edge). It records the tab you are looking at, follows you across tabs, supports freeze/draw/clear on any page, adds mic sound, and sends the result to our own FFmpeg server (Version 2) to make the MP4.

### What changed from the plan in section 5
| Plan | What the spike found | What we built |
|---|---|---|
| Capture with `tabCapture` | Refused unless the extension is invoked on that specific tab, so it cannot follow you silently across tabs | **Window capture**: one "Share window" pick (the one-time permission) follows every tab |
| Crop to the page | A window frame includes the tabs bar and address bar | **Self-calibration**: the page draws a magenta border at its edges, the recorder finds it in the frame and crops to it (re-done on zoom or resize) |
| Freeze the page | Cannot pause a live capture | `captureVisibleTab` snapshot placed in an overlay, drawn on, removed on Clear All |
| Overlay | Page CSS can break it | Closed shadow root in the browser top layer (`popover="manual"`) |
| MP4 by our own pipeline | Browser will not accept a call from our localhost server by default | Server option `allowedOrigins` (`ANNOTREC_ALLOWED_ORIGINS`) allows `chrome-extension://<id>`; fixed id via manifest `key` |
| Stop speed | Re-encoding on the server made Stop take several seconds | **`?video=copy`**: the browser records H.264, the server only repackages it (video copied, audio to AAC). Stop takes 0.3 to 0.8 s |

### Test results
- `test/e2e.mjs`: 18 of 18 checks, three runs in a row (share once, start, tab A live, freeze plus rectangle, clear, tab B with arrow, back to A, stop; pixel checks on the MP4, audio and video lengths match, real mic sound).
- `test/robustness.mjs`: 4 of 4 (zoom 150% and a mid-recording window resize).
- `test/panel.mjs`: 5 of 5 (side panel smoke test).

### Traps found (so nobody loses time again)
- Chromium blocks some ports (5061 is `ERR_UNSAFE_PORT`); use 5071 and up.
- Edge puts an invisible character (U+200B) in window titles. The picker auto-select flag needs the exact title text; `SpikeWindow A and` worked, shorter strings matched the tab or nothing.
- `--use-fake-ui-for-media-stream` forces a whole-screen pick; use `--auto-accept-camera-and-microphone-capture` instead.
- Offscreen documents have no `chrome.storage`; the service worker passes the server address in.
- The marker may not be on screen yet when calibration starts; retry for up to 4 s.
- Test timing must use the recorder's own `startedAt`, not the test's clock.

### Still open
- Not tested: Chrome, Brave, Opera (Edge only, as decided).
- A real person granting the microphone from the panel button (tests use a fake device).
- Managed-browser policy on unpacked extensions on company laptops.
- Next phases: port the V2 core and ink engine into a Vite/TypeScript extension, polish "follow active tab", OPFS library, Studio page.

### Annotation tools (added after the first spike)
Nine tools (pen, highlighter, line, arrow, box, circle, text, numbered marker, eraser), eight colours, size slider, undo/redo, keyboard shortcuts, all working on any page. `test/tools.mjs`: 16 of 16. Pause/resume is built (the paused time is cut from the MP4; `test/pause.mjs` 6 of 6). Select-and-move is built (`test/tools.mjs` 19 of 19; moves are not in the undo history yet). Still not ported from Version 2: pencil, screenshot, the library page, themes.

### Permissions, saved folder and speed (latest round)
- Microphone permission now has its own tab (`permission.html`), clear `Permission denied` message, and buttons for Edge and Windows settings; Start asks for the microphone and the window by itself.
- The server reports its recordings folder (`/api/health` -> `folder`) and can open it (`/api/reveal` without a name); the panel shows both.
- Recorder keeps the newest window frame as a VideoFrame (no per-frame copy) and calibrates with a shorter wait. Measured with `test/perf.mjs` on an animated page: 30 fps in the file, longest gap under about 100 ms, about 8% of a 12-core machine while recording.

### Production hardening (round 5)
Least-privilege manifest (desktopCapture removed), real icons and version 3.0.0, server address restricted to this computer, pre-flight check of server and FFmpeg, chunk retries, auto-save when the window share ends, microphone released when a start fails, plain-language messages for restricted pages, panel accessibility (labels, live regions, focus rings), self-reload after a rebuild (never while recording), static quality gate, and a runner (`npm run ext:test`): 11 suites, all passing, including a 90 s endurance recording.

### Round 6: Chrome and Brave, and more speed
- **Browsers**: the same code passes every suite in Edge, Chrome 157 and Brave 158. Tests pick the browser with `BROWSER=` (`test/browser.mjs`). Findings: the auto-select flag must match the window title with each browser's suffix (Edge ` and`, Chrome ` - Google Chrome`, Brave ` - Brave`), otherwise it can match the tab; Chrome 137+ ignores `--load-extension`, so the tests install through `Extensions.loadUnpacked` (DevTools protocol); a browser also has extensions of its own, so the test picks the service worker by extension id.
- **Self-reload** (`chrome.runtime.reload()`) brings the extension back in Edge only; in Chrome and Brave an extension installed by the test setups does not come back. It is therefore a setting there, off by default.
- **Speed**: still pages cost about 1.5% instead of about 10% (identical pictures are skipped, with a 500 ms keep-alive and a final picture at Stop); Start runs the microphone, the server and the page measurement in parallel; the panel polls slowly when idle; a fallback opens the controls in a small window if a browser has no side panel API.

### Round 7: instant Start and panel
- Start measured: 1.25 s first / 0.55 s later with a fake microphone. Where it went: cold audio start-up 0.8 s, page measuring (marker flash, polling, full-picture scan) 0.3-0.4 s, FFmpeg probe on the server's health check 0.2 s, one after another.
- Now: page measured once at share time and reused (valid while the window picture size and the page size in device pixels are unchanged, which makes it zoom-proof); microphone and server session prepared in parallel and handed over to Start (`prepare` / `cancelPrepare`); audio system warmed at share time; health check cached (extension 30 s, server 60 s for FFmpeg); marker search through two thin strips. Result about 0.2 s / 0.1 s, and 0.25 s from the real panel click to "Recording".
- Panel: optimistic states (Starting, Saving, lit tool), one message for freeze+tool+colour (`draw`), one message for everything the panel shows (`panelState`).
- Microphone button: asks the browser when it can; when blocked it opens the extension's site-settings page directly; the panel follows permission changes live.
- Not measured: a real microphone's own opening time.
