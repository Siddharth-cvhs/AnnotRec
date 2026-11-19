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
  prep: null, // the microphone and the server session, prepared while the page is being measured
  calKey: null,
  scan: null,
  shareInfo: null, // { surface: monitor | window | browser, width, height } of what is shared
};

/** Size of a window frame (VideoFrame, or an ImageBitmap in older paths). */
const fw = (f) => f.displayWidth ?? f.width;
const fh = (f) => f.displayHeight ?? f.height;
// The page is recorded a few pixels inside its edges: the light frame the page draws there while sharing or recording
// (see content.js) is therefore never in the video.
const INSET_CSS = 4;

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
  const st = track.getSettings();
  S.shareInfo = { surface: st.displaySurface ?? "window", width: st.width ?? 0, height: st.height ?? 0 }; // monitor | window | browser
  track.addEventListener("ended", async () => {
    S.track = null;
    S.shareInfo = null;
    chrome.runtime.sendMessage({ type: "share-ended" }).catch(() => {});
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
  return { ok: true, settings: track.getSettings(), label: track.label, surface: S.shareInfo.surface };
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
 * The same search, much cheaper: the marker is a rectangle, so a row through the middle of it and a column through
 * the middle of it are enough to find its four edges (two thin strips are read instead of about 1.5 million pixels).
 */
function findMarkerFast() {
  const f = S.latest;
  if (!f) return null;
  const W = fw(f), H = fh(f);
  if (!S.scan || S.scan.canvas.width !== W || S.scan.canvas.height !== H) {
    const canvas = new OffscreenCanvas(W, H);
    S.scan = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  const { ctx } = S.scan;
  ctx.drawImage(f, 0, 0);
  const magenta = (d, i) => d[i] > 200 && d[i + 1] < 70 && d[i + 2] > 200;
  const extent = (data, n) => {
    let a = -1, b = -1;
    for (let k = 0; k < n; k++) if (magenta(data, k * 4)) { if (a < 0) a = k; b = k; }
    return a < 0 ? null : [a, b];
  };
  const row = (y) => extent(ctx.getImageData(0, y, W, 1).data, W);
  const col = (x) => extent(ctx.getImageData(x, 0, 1, H).data, H);
  for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const r = row(Math.round(H * fy));
    if (!r || r[1] - r[0] < 100) continue; // both side bars of the marker must be there, far apart
    const c = col(Math.round((r[0] + r[1]) / 2));
    if (!c || c[1] - c[0] < 100) continue;
    const r2 = row(Math.round((c[0] + c[1]) / 2)); // once more, through the true middle
    if (!r2) continue;
    return { frame: { w: W, h: H }, x0: r2[0], y0: c[0], w: r2[1] - r2[0] + 1, h: c[1] - c[0] + 1 };
  }
  return null;
}

/**
 * Find the magenta frame the page drew at its edges; that rectangle IS the page inside the window picture.
 * The marker takes a moment to reach the capture (longer on a slow machine), so keep looking for a few seconds
 * instead of trusting a fixed wait.
 */
async function calibrate(geometry) {
  if (!S.latest) throw new Error("The window is not being captured. Share it first.");
  let m = null;
  // look every 25 ms (the marker is found as soon as it reaches the capture); after about a second of failing, use the
  // thorough full-picture search too
  for (let i = 0; i < 160 && !m; i++) {
    m = findMarkerFast() ?? (i >= 40 && i % 10 === 0 ? findMarker() : null);
    if (!m) await sleep(25);
  }
  if (!m) {
    throw new Error(
      S.shareInfo?.surface === "monitor"
        ? "AnnotRec cannot see this browser page on the screen you shared. Put the browser window on that screen, or press Share and choose the browser window instead."
        : "AnnotRec cannot find this page inside what you shared. Press Share and choose this browser window.",
    );
  }
  S.cal = {
    left: m.x0,
    bottomGap: m.frame.h - (m.y0 + m.h),
    scaleX: m.w / geometry.innerW,
    scaleY: m.h / geometry.innerH,
    dpr: geometry.dpr,
  };
  S.geo = geometry;
  // What this measurement is valid for: the window picture's size and the page's size in device pixels (which does
  // not change with zoom). If either changes, the page has to be measured again.
  S.calKey = { fw: m.frame.w, fh: m.frame.h, dw: Math.round(geometry.innerW * geometry.dpr), dh: Math.round(geometry.innerH * geometry.dpr) };
  return { frame: m.frame, page: { x: m.x0, y: m.y0, w: m.w, h: m.h }, cal: S.cal };
}

/** Is the earlier measurement still right for this page? Then Start needs no new measuring (and no marker flash). */
function calValid(geometry) {
  const k = S.calKey, f = S.latest;
  return !!(S.cal && k && f && k.fw === fw(f) && k.fh === fh(f) && k.dw === Math.round(geometry.innerW * geometry.dpr) && k.dh === Math.round(geometry.innerH * geometry.dpr));
}

/** The page in front as a picture, cut out of the newest window frame (for a page that cannot run our code). */
async function pagePicture({ w, h }) {
  const f = S.latest;
  if (!f) throw new Error("The window is not being shared.");
  if (!S.cal) throw new Error("The page position is not measured yet.");
  // The size of the page area comes from the last ordinary page in this window (a browser page cannot tell its own
  // size, and the number the browser reports for a tab is not exactly the page area); `w`, `h` are only the fallback.
  const zoom = S.geo ? S.geo.dpr / S.cal.dpr : 1;
  const sw = Math.round((S.geo?.innerW ?? w) * S.cal.scaleX * zoom), sh = Math.round((S.geo?.innerH ?? h) * S.cal.scaleY * zoom);
  const sx = S.cal.left, sy = fh(f) - S.cal.bottomGap - sh;
  const c = new OffscreenCanvas(sw, sh);
  c.getContext("2d").drawImage(f, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  const url = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
  return { ok: true, url, w: sw, h: sh };
}

/** The part of the newest window frame that is the page, for the tab in front right now. */
function pageRect(frame) {
  const { cal, geo } = S;
  const zoom = geo.dpr / cal.dpr; // zoom differs between sites; the page's own dpr tells us
  const sw = Math.round(geo.innerW * cal.scaleX * zoom);
  const sh = Math.round(geo.innerH * cal.scaleY * zoom);
  const ix = Math.round(INSET_CSS * cal.scaleX * zoom), iy = Math.round(INSET_CSS * cal.scaleY * zoom);
  return { sx: cal.left + ix, sy: fh(frame) - cal.bottomGap - sh + iy, sw: sw - 2 * ix, sh: sh - 2 * iy };
}

// -------------------------------------------------------------------- recording
const KEEPALIVE_MS = 500; // a still page still gets a picture at least this often, so the video never runs short of the audio

function tick(force = false) {
  const now = performance.now();
  if (S.lastTick) {
    S.maxGap = Math.max(S.maxGap, now - S.lastTick);
    if (now - S.lastTick > 100) S.slowTicks++; // a visible hitch: the picture waited more than 3 frames
  }
  S.lastTick = now;
  S.ticks++;
  const f = S.latest;
  if (!f || !S.cal || !S.geo) return;
  // Nothing new in the window and the same page size: the last picture is still right. Skipping it saves the
  // drawing and the encoder's work (a talk over a still page is most of a demo).
  const key = `${S.geo.innerW}x${S.geo.innerH}@${S.geo.dpr}`;
  if (!force && S.windowFrames === S.drawnFrames && key === S.drawnKey && now - S.drawnAt < KEEPALIVE_MS) {
    S.skipped++;
    return;
  }
  S.drawnFrames = S.windowFrames;
  S.drawnKey = key;
  S.drawnAt = now;
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
    abort() {
      fetch(`${server}/api/live/${id}`, { method: "DELETE" }).catch(() => {});
    },
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

const GUM_AUDIO = { audio: { echoCancellation: true, noiseSuppression: true } };

/** Open the microphone and hook up the level meter. Never throws: a missing microphone only means no sound. */
function openMic(micOn) {
  return (async () => {
    try {
      const mic = await navigator.mediaDevices.getUserMedia(GUM_AUDIO);
      const track = mic.getAudioTracks()[0];
      track.enabled = micOn;
      S.micPeak = 0;
      S.micState = { readyState: track.readyState, muted: track.muted, label: track.label };
      const rd = new MediaStreamTrackProcessor({ track }).readable.getReader();
      (async () => {
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          const buf = new Float32Array(value.numberOfFrames);
          try { value.copyTo(buf, { planeIndex: 0, format: "f32-planar" }); } catch { /* format not available */ }
          let chunk = 0;
          for (const x of buf) chunk = Math.max(chunk, Math.abs(x));
          S.micPeak = Math.max(S.micPeak, chunk);
          S.micLevel = Math.max(chunk, (S.micLevel || 0) * 0.97); // quick up, slow down
          value.close();
        }
      })();
      return { mic, track, issue: null };
    } catch (e) {
      return { mic: null, track: null, issue: `No microphone (${e.message}); recording without sound.` };
    }
  })();
}

/**
 * Start the slow things now: the microphone (a device has to be opened) and the server session. The caller keeps
 * measuring the page meanwhile, and `start` then only has to collect the results.
 */
function beginPrepare({ micOn = true, quality = "standard", server = "http://localhost:4000", codec = "h264" } = {}) {
  cancelPrepare();
  const h264 = codec === "h264" && MediaRecorder.isTypeSupported("video/webm;codecs=h264,opus");
  const upload = openUpload(server, quality, h264);
  upload.catch(() => {}); // reported where it is used
  S.prep = { upload, mic: openMic(micOn), h264 };
}

function cancelPrepare() {
  const p = S.prep;
  S.prep = null;
  if (!p) return;
  p.mic.then((m) => m.mic?.getTracks().forEach((t) => t.stop()));
  p.upload.then((u) => u.abort(), () => {});
}

/** One throw-away microphone opening, done once when the window is shared: the first opening of the audio system is slow. */
async function prewarmMic() {
  try {
    if ((await navigator.permissions.query({ name: "microphone" })).state !== "granted") return { skipped: true };
    const t0 = performance.now();
    (await navigator.mediaDevices.getUserMedia(GUM_AUDIO)).getTracks().forEach((t) => t.stop());
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

/** codec: "h264" (the browser encodes, the server only repackages) or "vp9" (the server re-encodes to H.264). */
async function startUnsafe(options = {}) {
  const { debugRaw = false } = options;
  S.pieces = debugRaw ? [] : null;
  if (S.recorder) throw new Error("Already recording.");
  if (!S.cal || !S.geo) throw new Error("Not calibrated yet.");

  const T0 = performance.now();
  S.out = { w: even((S.geo.innerW - 2 * INSET_CSS) * S.cal.scaleX), h: even((S.geo.innerH - 2 * INSET_CSS) * S.cal.scaleY) };
  S.canvas = document.createElement("canvas");
  S.canvas.width = S.out.w;
  S.canvas.height = S.out.h;
  S.ctx = S.canvas.getContext("2d", { alpha: false });
  const canvasStream = S.canvas.captureStream(0);
  S.videoTrack = canvasStream.getVideoTracks()[0];

  if (!S.prep) beginPrepare(options); // (normally already begun by "prepare", while the page was being measured)
  const prep = S.prep;
  S.prep = null;
  const tracks = [S.videoTrack];
  const m = await prep.mic;
  S.mic = m.mic;
  S.micTrack = m.track;
  S.micIssue = m.issue;
  if (m.track) tracks.push(m.track);
  const T1 = performance.now(); // microphone is ready
  const h264 = prep.h264;
  S.upload = await prep.upload;
  const T2 = performance.now(); // the server session is ready
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
  S.ticks = 0;
  S.slowTicks = 0;
  S.skipped = 0;
  S.drawnFrames = -1;
  S.drawnKey = "";
  S.drawnAt = 0;
  S.maxGap = 0;
  S.lastTick = 0;
  S.windowFrames = 0;
  tick();
  S.timer = setInterval(tick, 1000 / 30);
  S.recorder.start(1000);
  S.startedAt = Date.now();
  S.pausedAt = 0;
  S.pausedTotal = 0;
  return { ok: true, out: S.out, micIssue: S.micIssue, codec: S.codecUsed, startedAt: S.startedAt, timings: { micMs: Math.round(T1 - T0), serverWaitMs: Math.round(T2 - T1), totalMs: Math.round(performance.now() - T0) } };
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
    S.upload?.abort();
    S.upload = null;
    cancelPrepare();
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
  tick(true); // the picture at the very end
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
  return { ok: true, rawBase64, saved, durationMs, framesDrawn: S.frames, ticks: S.ticks, slowTicks: S.slowTicks, skipped: S.skipped, maxTickGapMs: Math.round(S.maxGap), windowFramesReceived: S.windowFrames, micPeak: Number(S.micPeak.toFixed(4)), micState: S.micState };
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
      case "pagePicture":
        return pagePicture(m);
      case "prepare":
        beginPrepare(m);
        return { ok: true };
      case "cancelPrepare":
        cancelPrepare();
        return { ok: true };
      case "prewarm":
        return prewarmMic();
      case "calValid":
        return { valid: calValid(m.geometry) };
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
          share: S.shareInfo ?? null,
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
