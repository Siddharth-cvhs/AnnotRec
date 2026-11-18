// AnnotRec recorder: a hidden page that lives as long as the recording does.
//
//  window stream ──▶ newest frame ──▶ crop to the page area ──▶ canvas ──┐
//                                                                         ├─▶ MediaRecorder ─▶ pieces ─▶ our FFmpeg server ─▶ MP4
//  microphone ────────────────────────────────────────────────────────────┘
//
// The picture is the whole browser window, picked once; because it is the window, it follows the tab in
// front by itself. The crop removes the tab strip, address bar and side panel. Where the page is inside
// the window is measured (calibrate) from a marker the page draws; its size comes from the page itself.

const S = {
  track: null,
  latest: null, // newest window frame as an ImageBitmap
  cal: null, // { left, bottomGap, scaleX, scaleY, dpr }
  geo: null, // { innerW, innerH, dpr } of the tab in front
  out: { w: 0, h: 0 },
  canvas: null,
  ctx: null,
  timer: 0,
  recorder: null,
  mic: null,
  micTrack: null,
  upload: null,
  startedAt: 0,
  frames: 0,
  lastTick: 0,
  maxGap: 0,
  windowFrames: 0,
  micPeak: 0,
  micState: null,
  busy: 0, // starting or stopping right now
};

/** Size of a window frame (VideoFrame, or an ImageBitmap in older paths). */
const fw = (f) => f.displayWidth ?? f.width;
const fh = (f) => f.displayHeight ?? f.height;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ---------------------------------------------------------------- window stream
/** Share the browser window with the standard picker (one pick; the picture then follows the tab in front). */
async function attachDisplay() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window", frameRate: 30 }, audio: false });
  return useStream(stream);
}

async function useStream(stream) {
  S.track?.stop();
  const [track] = stream.getVideoTracks();
  S.track = track;
  track.addEventListener("ended", async () => {
    S.track = null;
    if (!S.recorder) return;
    // Do not lose the recording: finish and save it, and tell the user why it stopped.
    try {
      const r = await stop();
      chrome.runtime.sendMessage({ type: "auto-stopped", reason: "The window share ended, so the recording was stopped and saved.", saved: r.saved, durationMs: r.durationMs }).catch(() => {});
    } catch (e) {
      chrome.runtime.sendMessage({ type: "auto-stopped", reason: "The window share ended and the recording could not be saved.", error: String(e.message ?? e) }).catch(() => {});
    }
  });
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      S.windowFrames++;
      // Keep the newest frame as it is (no copy). Only one is held at a time, so the capture never stalls.
      S.latest?.close();
      S.latest = value;
    }
  })();
  for (let i = 0; i < 40 && !S.latest; i++) await sleep(50);
  return { ok: true, settings: track.getSettings(), label: track.label };
}

// ------------------------------------------------------------------ calibration
/** Look for the magenta frame in the newest window picture; null if it is not there (yet). */
function findMarker() {
  const f = S.latest;
  if (!f) return null;
  const c = new OffscreenCanvas(fw(f), fh(f));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(f, 0, 0);
  const d = ctx.getImageData(0, 0, fw(f), fh(f)).data;
  let x0 = fw(f), y0 = fh(f), x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < fh(f); y++) {
    for (let x = 0; x < fw(f); x++) {
      const i = (y * fw(f) + x) * 4;
      if (d[i] > 200 && d[i + 1] < 70 && d[i + 2] > 200) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return n < 200 ? null : { frame: { w: fw(f), h: fh(f) }, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Find the magenta frame the page drew at its edges; that rectangle IS the page inside the window picture.
 * The marker takes a moment to reach the capture (longer on a slow machine), so keep looking for a few seconds
 * instead of trusting a fixed wait.
 */
async function calibrate(geometry) {
  if (!S.latest) throw new Error("The window is not being captured. Share it first.");
  let m = null;
  for (let i = 0; i < 40 && !m; i++) {
    m = findMarker();
    if (!m) await sleep(100);
  }
  if (!m) throw new Error("Could not find the page inside the window picture (marker not seen).");
  S.cal = {
    left: m.x0,
    bottomGap: m.frame.h - (m.y0 + m.h),
    scaleX: m.w / geometry.innerW,
    scaleY: m.h / geometry.innerH,
    dpr: geometry.dpr,
  };
  S.geo = geometry;
  return { frame: m.frame, page: { x: m.x0, y: m.y0, w: m.w, h: m.h }, cal: S.cal };
}

/** The part of the newest window frame that is the page, for the tab in front right now. */
function pageRect(frame) {
  const { cal, geo } = S;
  const zoom = geo.dpr / cal.dpr; // zoom differs between sites; the page's own dpr tells us
  const sw = Math.round(geo.innerW * cal.scaleX * zoom);
  const sh = Math.round(geo.innerH * cal.scaleY * zoom);
  return { sx: cal.left, sy: fh(frame) - cal.bottomGap - sh, sw, sh };
}

// -------------------------------------------------------------------- recording
function tick() {
  const now = performance.now();
  if (S.lastTick) S.maxGap = Math.max(S.maxGap, now - S.lastTick);
  S.lastTick = now;
  const f = S.latest;
  if (!f || !S.cal || !S.geo) return;
  const { sx, sy, sw, sh } = pageRect(f);
  const { w, h } = S.out;
  // Keep the page's shape inside a fixed-size picture (other tabs may be a different size).
  const k = Math.min(w / sw, h / sh);
  const dw = Math.round(sw * k);
  const dh = Math.round(sh * k);
  S.ctx.fillStyle = "#000";
  S.ctx.fillRect(0, 0, w, h);
  S.ctx.drawImage(f, sx, sy, sw, sh, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
  S.videoTrack.requestFrame();
  S.frames++;
}

async function openUpload(server, quality, copyVideo) {
  let r;
  try {
    r = await fetch(`${server}/api/live?quality=${quality}${copyVideo ? "&video=copy" : ""}`, { method: "POST" });
  } catch {
    throw new Error(`Cannot reach the AnnotRec server at ${server}. Start it (npm start) and try again.`);
  }
  if (!r.ok) throw new Error(`The AnnotRec server refused the recording (${r.status}). Is it running, and does it allow this extension?`);
  const { id } = await r.json();
  let chain = Promise.resolve();
  let failed = null;
  return {
    id,
    push(blob) {
      chain = chain
        .then(async () => {
          if (failed) return;
          // a short hiccup (server busy, brief network error) must not lose the recording: retry a few times
          for (let attempt = 1; ; attempt++) {
            try {
              const res = await fetch(`${server}/api/live/${id}/chunk`, { method: "POST", body: blob });
              if (!res.ok) throw new Error(`chunk ${res.status}`);
              return;
            } catch (e) {
              if (attempt >= 4) throw e;
              await sleep(300 * attempt);
            }
          }
        })
        .catch((e) => (failed = e));
    },
    async finish(durationMs) {
      await chain;
      if (failed) throw new Error(`upload failed: ${failed.message}`);
      const res = await fetch(`${server}/api/live/${id}/finish?durationMs=${Math.round(durationMs)}`, { method: "POST" });
      const text = await res.text();
      let done = null;
      for (const line of text.trim().split("\n")) {
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.done) done = msg.done;
      }
      if (!done) throw new Error("The server stopped before the MP4 was ready.");
      return done;
    },
  };
}

/** codec: "h264" (the browser encodes, the server only repackages) or "vp9" (the server re-encodes to H.264). */
async function startUnsafe({ micOn = true, quality = "standard", server = "http://localhost:4000", codec = "h264", debugRaw = false } = {}) {
  S.pieces = debugRaw ? [] : null;
  if (S.recorder) throw new Error("Already recording.");
  if (!S.cal || !S.geo) throw new Error("Not calibrated yet.");

  S.out = { w: even(S.geo.innerW * S.cal.scaleX), h: even(S.geo.innerH * S.cal.scaleY) };
  S.canvas = document.createElement("canvas");
  S.canvas.width = S.out.w;
  S.canvas.height = S.out.h;
  S.ctx = S.canvas.getContext("2d", { alpha: false });
  const canvasStream = S.canvas.captureStream(0);
  S.videoTrack = canvasStream.getVideoTracks()[0];

  const tracks = [S.videoTrack];
  S.micIssue = null;
  try {
    S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    S.micTrack = S.mic.getAudioTracks()[0];
    S.micTrack.enabled = micOn;
    tracks.push(S.micTrack);
    // Diagnostics: the loudest sample the microphone delivers while recording.
    S.micPeak = 0;
    S.micState = { readyState: S.micTrack.readyState, muted: S.micTrack.muted, label: S.micTrack.label };
    const rd = new MediaStreamTrackProcessor({ track: S.micTrack }).readable.getReader();
    (async () => {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        const buf = new Float32Array(value.numberOfFrames);
        try { value.copyTo(buf, { planeIndex: 0, format: "f32-planar" }); } catch { /* format not available */ }
        let chunk = 0;
        for (const x of buf) chunk = Math.max(chunk, Math.abs(x));
        S.micPeak = Math.max(S.micPeak, chunk);
        S.micLevel = Math.max(chunk, (S.micLevel || 0) * 0.97); // for the level meter: quick up, slow down
        value.close();
      }
    })();
  } catch (e) {
    S.micIssue = `No microphone (${e.message}); recording without sound.`;
  }

  const h264 = codec === "h264" && MediaRecorder.isTypeSupported("video/webm;codecs=h264,opus");
  S.upload = await openUpload(server, quality, h264);
  S.recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType: h264
      ? "video/webm;codecs=h264,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm",
    videoBitsPerSecond: h264 ? 6_000_000 : 8_000_000,
  });
  S.codecUsed = h264 ? "h264" : "vp9";
  S.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    S.pieces?.push(e.data);
    S.upload.push(e.data);
  };
  S.frames = 0;
  S.maxGap = 0;
  S.lastTick = 0;
  S.windowFrames = 0;
  tick();
  S.timer = setInterval(tick, 1000 / 30);
  S.recorder.start(1000);
  S.startedAt = Date.now();
  S.pausedAt = 0;
  S.pausedTotal = 0;
  return { ok: true, out: S.out, micIssue: S.micIssue, codec: S.codecUsed, startedAt: S.startedAt };
}

async function start(options = {}) {
  S.busy++;
  try {
    return await startUnsafe(options);
  } catch (e) {
    clearInterval(S.timer);
    S.recorder = null;
    S.mic?.getTracks().forEach((t) => t.stop());
    S.mic = S.micTrack = null;
    throw e;
  } finally {
    S.busy--;
  }
}

// Pause: the recorder drops the paused time, so the MP4 simply continues where it left off.
const elapsed = () => (S.recorder ? Date.now() - S.startedAt - S.pausedTotal - (S.pausedAt ? Date.now() - S.pausedAt : 0) : 0);

function pause() {
  if (!S.recorder) throw new Error("Not recording.");
  if (S.pausedAt) return { ok: true, paused: true };
  S.recorder.pause();
  clearInterval(S.timer);
  S.pausedAt = Date.now();
  return { ok: true, paused: true };
}

function resume() {
  if (!S.recorder) throw new Error("Not recording.");
  if (!S.pausedAt) return { ok: true, paused: false };
  S.pausedTotal += Date.now() - S.pausedAt;
  S.pausedAt = 0;
  S.lastTick = 0; // the gap while paused is not a stall
  tick(); // the first picture after resuming is the page as it is now
  S.recorder.resume();
  S.timer = setInterval(tick, 1000 / 30);
  return { ok: true, paused: false };
}

async function stopUnsafe() {
  if (!S.recorder) throw new Error("Not recording.");
  if (S.pausedAt) resume();
  clearInterval(S.timer);
  const recorder = S.recorder;
  const done = new Promise((r) => (recorder.onstop = r));
  recorder.stop();
  await done;
  S.recorder = null;
  S.mic?.getTracks().forEach((t) => t.stop());
  S.mic = S.micTrack = null;
  const durationMs = Date.now() - S.startedAt - S.pausedTotal;
  const saved = await S.upload.finish(durationMs);
  S.upload = null;
  let rawBase64 = null;
  if (S.pieces) {
    const buf = new Uint8Array(await new Blob(S.pieces).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    rawBase64 = btoa(s);
    S.pieces = null;
  }
  return { ok: true, rawBase64, saved, durationMs, framesDrawn: S.frames, maxTickGapMs: Math.round(S.maxGap), windowFramesReceived: S.windowFrames, micPeak: Number(S.micPeak.toFixed(4)), micState: S.micState };
}

/** While a recording is starting or being finished it must not be interrupted (a reload would lose it). */
async function stop() {
  S.busy++;
  try {
    return await stopUnsafe();
  } finally {
    S.busy--;
  }
}

// -------------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.target !== "offscreen") return;
  const run = async () => {
    switch (m.type) {
      case "peek": {
        // debugging aid: the newest window frame as a JPEG
        if (!S.latest) throw new Error("no frame");
        const c = new OffscreenCanvas(fw(S.latest), fh(S.latest));
        c.getContext("2d").drawImage(S.latest, 0, 0);
        const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.6 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { ok: true, w: fw(S.latest), h: fh(S.latest), jpegBase64: btoa(s) };
      }
      case "attachDisplay":
        return attachDisplay();
      case "calibrate":
        return calibrate(m.geometry);
      case "geometry":
        S.geo = { innerW: m.innerW, innerH: m.innerH, dpr: m.dpr };
        return { ok: true };
      case "start":
        return start(m);
      case "stop":
        return stop();
      case "simulateShareEnded": // test hook: the same thing that happens when the user presses "Stop sharing"
        S.track?.stop();
        S.track?.dispatchEvent(new Event("ended"));
        return { ok: true };
      case "pause":
        return pause();
      case "resume":
        return resume();
      case "mic":
        if (S.micTrack) S.micTrack.enabled = !!m.on;
        return { ok: true };
      case "status":
        return {
          sharing: !!S.track,
          calibrated: !!S.cal,
          recording: !!S.recorder,
          busy: S.busy > 0 || !!S.recorder,
          paused: !!S.pausedAt,
          micLevel: S.recorder && S.micTrack?.enabled ? Number((S.micLevel || 0).toFixed(3)) : 0,
          micOn: S.micTrack ? S.micTrack.enabled : null,
          elapsedMs: elapsed(),
          frames: S.frames,
          geo: S.geo,
        };
    }
  };
  run().then(reply, (e) => reply({ error: String(e.message ?? e) }));
  return true;
});
