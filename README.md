# AnnotRec

A Windows screen recorder for explaining things on a live web page: you show an
app in a bounded viewport, record it with your microphone, draw on it while
you talk, and get **one MP4** with the page, your drawings and your voice.

> **Version 1 (this branch, `main`, tag `v1.0.0`): the Windows desktop app**
> (Tauri + Rust + React, native capture, no FFmpeg).
> **Version 2 (branch [`version-2`](../../tree/version-2), tag `v2.0.0`): the same tool as a
> React + Node web app** served on a local port, built to be extended with plugins and
> embedded in other apps. Get it with `git checkout version-2`.

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

## Run it

Prerequisites (Windows 10 1903+ or 11): Node 20+, Rust (MSVC toolchain) with
the Visual Studio C++ Build Tools, and the WebView2 runtime.

```bash
npm install
npm run tauri dev          # development
npm run tauri build -- --no-bundle   # standalone exe in src-tauri/target/release
```

`dist-exe/AnnotRec.exe` (if present) is a ready-built copy of the latter.

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
