// Converter port, default implementation: FFmpeg.
//
// A converter is anything with this shape:
//
//   qualities:                       ["standard", "high", ...]
//   available():                     Promise<boolean>
//   start(input, output, opts):      { stdin, promise, kill() }
//       input   a file path, or null to read the WebM from `stdin` (live)
//       opts    { quality, onProgress(ms), signal }
//       promise resolves with the output duration in ms
//
// Swap it for another encoder (hardware, a remote service...) without touching
// the routes.

import { spawn } from "node:child_process";

const PRESETS = {
  standard: { crf: 23, preset: "veryfast" },
  high: { crf: 18, preset: "fast" },
};

export class FFmpegConverter {
  constructor(ffmpegPath = "ffmpeg") {
    this.ffmpegPath = ffmpegPath;
    this.qualities = Object.keys(PRESETS);
  }

  available() {
    return new Promise((resolve) => {
      const p = spawn(this.ffmpegPath, ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
  }

  /**
   * H.264 + AAC in an MP4 that plays everywhere.
   *  - MediaRecorder writes frames only when the picture changes, so the output
   *    is forced to a constant 30 fps (still stretches repeat the last frame).
   *  - Sizes are rounded to even numbers (yuv420p needs them).
   *  - `aresample=async=1` keeps the voice in step with the picture.
   *  - `+faststart` puts the index first so the file plays while downloading.
   */
  start(input, output, { quality = "standard", videoCopy = false, onProgress, signal } = {}) {
    const q = PRESETS[quality] ?? PRESETS.standard;
    // videoCopy: the picture is already H.264 (the browser encoded it, usually in hardware), so it is only
    // repackaged into the MP4. Almost no CPU, so a live conversion never falls behind; only the audio is converted.
    const video = videoCopy
      ? ["-c:v", "copy"]
      : [
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v", "libx264",
          "-preset", q.preset,
          "-crf", String(q.crf),
          "-tune", "animation", // flat UI colours and sharp text
          "-pix_fmt", "yuv420p",
          "-fps_mode", "cfr",
          "-r", "30",
        ];
    const args = [
      "-y",
      "-nostats",
      "-progress", "pipe:1",
      "-i", input ?? "pipe:0",
      ...video,
      "-c:a", "aac",
      "-b:a", "128k",
      "-af", "aresample=async=1:first_pts=0",
      "-movflags", "+faststart",
      "-f", "mp4", // explicit: the output may be a ".part" file
      output,
    ];
    const proc = spawn(this.ffmpegPath, args, { stdio: [input ? "ignore" : "pipe", "pipe", "pipe"] });
    const promise = new Promise((resolve, reject) => {
      let log = "";
      let last = 0;
      let buf = "";
      proc.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) {
            last = Number(m[1]) / 1000; // microseconds in practice
            onProgress?.(last);
          }
        }
      });
      proc.stderr.on("data", (d) => (log = (log + d).slice(-4000)));
      const abort = () => proc.kill("SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      proc.on("error", (e) => reject(new Error(`Cannot run FFmpeg (${e.message}). Install it or set FFMPEG_PATH.`)));
      proc.on("exit", (code) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return reject(new Error("Cancelled."));
        code === 0 ? resolve(last) : reject(new Error(`FFmpeg failed:\n${log}`));
      });
    });
    proc.stdin?.on("error", () => {}); // a write to a dead FFmpeg must not crash the server
    return { stdin: proc.stdin, promise, kill: () => proc.kill("SIGKILL") };
  }
}
