# AnnotRec: Version 1 · Desktop app (Windows `.exe`)

A Windows screen recorder for explaining things on a live web page: you show an
app in a bounded viewport, record it with your microphone, draw on it while
you talk, and get **one MP4** with the page, your drawings and your voice.

## Which version is this?

| | **Version 1 (this one)** | Version 2 |
|---|---|---|
| **Label** | **DESKTOP APP, Windows `.exe`** | WEB APP, React + Node.js |
| **Branch / tag** | **`main` (default) · `v1.0.0`** | [`version-2`](../../tree/version-2) · `v2.0.0` |
| **What you run** | A native program with its own windows (a built `AnnotRec.exe`) | A Node server, opened in Edge or Chrome at `http://localhost:4000` |
| **Platform** | Windows 10 (1903+) and 11 only | Anything that runs Node, with Edge or Chrome |
| **Main languages** | Rust (recording) + TypeScript/React (toolbar, drawing) | JavaScript (server) + TypeScript/React (client) |
| **Recording engine** | Native Windows capture and encoder, no FFmpeg | The browser records, FFmpeg converts to MP4 |
| **Built for** | A self-contained tool you just run | Being extended with plugins and embedded in other apps |

You are reading **Version 1**. To get Version 2 instead:
`git clone -b version-2 https://github.com/Siddharth-cvhs/AnnotRec.git`.

## Tech stack (Version 1: Rust + Tauri desktop app)

**Application shell**

| Technology | Version | What it does here |
|---|---|---|
| **Tauri** | 2.12 (tauri-build 2.7) | The desktop framework: builds the `.exe`, opens the three windows, connects the UI to the Rust code, bundles the UI inside the exe |
| **WebView2** (Microsoft Edge engine) via `wry` 0.57 and `tao` 0.37 | runtime preinstalled on Windows 11 | Renders the toolbar, the drawing overlay and the page being recorded |
| **Rust** | 2021 edition, built with 1.100 | All native logic: capture, audio, encoding, windows, the state machine |

**Native recording (Rust, Windows only)**

| Technology | Version | What it does here |
|---|---|---|
| **Windows Graphics Capture** via the `windows-capture` crate | 2.0.1 | Captures the monitor frame by frame and crops it to the viewport |
| **Media Foundation** H.264 encoder + AAC (hardware accelerated when the GPU offers it) | built into Windows | Encodes video and audio straight into one MP4, no FFmpeg |
| **WASAPI** microphone via the `windows` crate | 0.62 | Reads the microphone; pause and live mute are handled in the pacing loop |
| **xcap** | 0.9 | Monitor geometry and the picture used to freeze the page and for screenshots |
| `serde`, `serde_json`, `chrono`, `base64`, `url` | 1.x, 0.4, 0.22, 2.x | Messages between UI and Rust, file names, the frozen picture, address checks |

**Frontend (runs inside WebView2)**

| Technology | Version | What it does here |
|---|---|---|
| **React** + **TypeScript** | 19.3 + 7.0 | The toolbar and the annotation overlay |
| **Vite** | 8.3 | Builds the UI (and serves it in development) |
| `@tauri-apps/api` | 2.12 | Calls the Rust commands and listens to events |
| **lucide-react** | 1.73 | Icons |
| HTML **canvas** + plain CSS | n/a | The drawing layer (own shape model, no drawing library) and styling |

**Tooling to build it:** Node.js and npm, the Rust toolchain (`rustup`, MSVC target),
Visual Studio Build Tools (C++ workload), Tauri CLI 2.12.
**Origins:** the recorder and microphone code is adapted from
[Socorin](https://github.com/huystr/socorin) (Apache-2.0); see `NOTICE` and `ATTRIBUTION.md`.

## What it does

* **Viewport.** The page you record lives in its own window (an embedded
  WebView2, the Edge engine). Type `localhost:3000` or any URL in the toolbar.
  Only the inside of that window is recorded, so the toolbar is never in the
  video (it is also excluded from screen capture).
* **Start / Pause / Resume / Stop.** Start records the viewport and the
  microphone. Pause really pauses video, sound and the timer. Stop writes the
  MP4 to `Videos\AnnotRec`.
* **Annotate while recording.** Pick any drawing tool and the page *freezes*
  (a snapshot of it is shown), the mouse goes to the drawing layer, and the
  recording **keeps running** with the microphone on. Tools: pen, pencil,
  highlighter, line, arrow, rectangle, circle, text, eraser, undo, redo,
  colours and size.
* **Clear all.** Removes every drawing, unfreezes the page and gives you the
  live page back. Recording is untouched.
* **Screenshot.** Saves the viewport (with any drawings) to
  `Pictures\AnnotRec`.
* **Microphone on/off**, live, during the recording.

Everything stays on your machine. Nothing is uploaded.

## Quick start (Version 1)

### 1. What you need (Windows 10 1903+ or Windows 11)

| Need | Tested with | Check it |
|---|---|---|
| **Node.js** 20.19 or newer, with npm | 24.14 | `node -v` |
| **Rust** with the MSVC toolchain (`rustup`) | 1.100 | `rustc -V` |
| **Visual Studio Build Tools**, workload "Desktop development with C++" | 2022 | needed by Rust to link; see below |
| **WebView2 runtime** | 157 | preinstalled on Windows 11; on Windows 10 install the Evergreen runtime from Microsoft |
| A microphone | any | optional; without one it records silently |

Not installed yet? From PowerShell:

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Open a **new** terminal afterwards so `cargo` is on your PATH.

### 2. Get the code and install

```bash
git clone https://github.com/Siddharth-cvhs/AnnotRec.git
cd AnnotRec          # you are on main = Version 1
npm install
```

### 3a. Run it while developing

```bash
npm run tauri dev
```

The first run compiles all the Rust dependencies and takes **5 to 10 minutes**; after that it
starts in seconds and rebuilds when you change code. (Its toolbar UI is served from a temporary
`localhost:1420` while developing; the built exe does not need that.)

### 3b. Build the `.exe` and run it

```bash
npm run tauri build -- --no-bundle
```

Your exe is `src-tauri\target\release\annotrec.exe`. Double-click it. (For a faster, slightly
bigger test build, run `$env:CARGO_PROFILE_RELEASE_LTO = "false"` in PowerShell first. Plain
`npm run tauri build` also makes an installer, but downloads the NSIS tooling.)

### 4. Using it for the first time

1. The **viewport** window shows a demo page. In the **AnnotRec** toolbar window type your own
   address (for example `localhost:3000`) and press Go.
2. Press **Start** (allow the microphone if Windows asks) and talk.
3. Pick a drawing tool: the page freezes while you draw and talk and recording continues.
   **Clear all** brings the live page back.
4. Press **Stop**. The MP4 is saved in `Videos\AnnotRec` (screenshots in `Pictures\AnnotRec`);
   **Show in folder** opens it.

| Problem | Fix |
|---|---|
| `cargo` / `rustc` not found | Open a new terminal after installing Rust |
| `link.exe` not found | Install the Visual Studio Build Tools C++ workload |
| Toolbar window is blank | Install or repair the WebView2 runtime |
| The video has no sound | Windows Settings, Privacy, Microphone: allow desktop apps |
| Can't see the toolbar in a screenshot | By design: it is excluded from screen capture |

## How it works

```
 toolbar window ──invoke──▶ Rust session (state machine)
                               │ emit "freeze"/"overlay-cmd"/"clear-all"
                               ▼
 viewport window  ◀── same rectangle ──▶  overlay window (transparent,
 (live page)                               always on top, click-through
                                           when live)
        ▲
        └── Windows.Graphics.Capture of the monitor, cropped to the viewport,
            → Media Foundation H.264 + AAC (microphone via WASAPI) → MP4
```

* **Recording** (`src-tauri/src/wgc.rs`, from Socorin): Windows Graphics Capture
  frames are cropped to the viewport rectangle and fed, at a steady 30 fps, to a
  hardware-accelerated Media Foundation encoder. The microphone is read through
  WASAPI on the same clock. No FFmpeg is needed.
* **Freeze without pausing** (`session.rs`, `layout.rs`, `Overlay.tsx`): the
  recorder captures the screen, so whatever is on screen goes into the video. In
  live mode a transparent overlay sits exactly on the viewport and lets clicks
  through. Choosing a tool takes a snapshot of the viewport, shows it in the
  overlay as an opaque backdrop and makes the overlay take the mouse; drawings
  go on top. The recorder never stops, so the video shows the frozen page, the
  ink appearing and your voice. *Clear all* hides the backdrop and the ink and
  makes the overlay click-through again.
* **State.** Two independent axes in `session.rs`: recording
  (`Idle → Recording ⇄ Paused → Stopping`) and annotation (`live ⇄ annotating`).
* **Pause** (`wgc.rs::pace_with`): the pacing loop stops sending frames and
  sound and shifts its clock by the time paused, so the file has no gap.
* **Audio/video sync**: both tracks start at the first captured frame.

## Layout of the code

| Path | Role |
|---|---|
| `src-tauri/src/wgc.rs` | WGC capture, pacing, pause/mute, MF encoder |
| `src-tauri/src/audio.rs` | microphone listing and WASAPI capture |
| `src-tauri/src/area.rs` | monitor geometry and viewport snapshots |
| `src-tauri/src/layout.rs` | the viewport / overlay / toolbar windows |
| `src-tauri/src/session.rs` | state machine and commands |
| `src/Toolbar.tsx` | controls |
| `src/Overlay.tsx`, `src/drawing.ts` | drawing layer and shape model |
| `public/sample.html` | built-in demo page |
| `src-tauri/examples/record_test.rs` | headless recording test tool |

## Known limits

* The viewport window is locked in place while recording (it snaps back if
  moved), because the recorded rectangle is fixed at Start.
* Another window dragged over the viewport is recorded (the overlay is
  transparent). Keep the viewport uncovered.
* Windows only. Windows 10 may draw a yellow capture frame around the display.
* No system (speaker) audio and no captions/transcript yet.
* A second monitor works, but a viewport that spans two monitors is clipped to
  the monitor holding its centre.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `ATTRIBUTION.md`.
