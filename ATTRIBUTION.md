# Open-source attribution

| Repository | Licence | Used | Changes |
|---|---|---|---|
| [Socorin](https://github.com/huystr/socorin) | Apache-2.0 | `src-tauri/src/wgc.rs` (Windows Graphics Capture + Media Foundation recorder), `src-tauri/src/audio.rs` (WASAPI microphone), the Tauri project scaffold | Areas are physical pixels; pause/resume and live mute added; audio and video both start at the first frame (the original starts the sound clock earlier, which leaves the voice behind the picture); removed settings, share, updater and the macOS/Linux paths |
| [MarkerOn](https://github.com/ifer47/markeron) | MIT | Design reference only: a transparent always-on-top overlay window that toggles click-through | No code copied |
| [Flowtake](https://github.com/JNX03/Flowtake) | MIT | Reference only (FFmpeg `ddagrab` capture, overlay window set-up) | Nothing used |
| Prisc (by Caelan Sayler; clone in `..\Prisc`) | GPL-3.0 with extra terms | Studied only. **No code, assets or names were taken**, because GPL-3.0 would apply to this project | None |

Third-party libraries: Tauri 2, windows-capture, xcap, React, lucide-react and
the crates listed in `src-tauri/Cargo.lock`, each under its own licence.
