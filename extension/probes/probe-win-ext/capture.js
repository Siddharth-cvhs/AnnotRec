// Window-capture probe: share the whole browser window once, keep the newest frame,
// and measure where the page content sits inside it.
let latest = null;
let settings = null;

document.getElementById("share").onclick = async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window", frameRate: 30 }, audio: false });
  } catch (e) {
    window.shareError = String(e.name + ": " + e.message);
    return;
  }
  const [track] = stream.getVideoTracks();
  settings = track.getSettings();
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const bitmap = await createImageBitmap(value);
      value.close();
      latest?.close();
      latest = bitmap;
    }
  })();
  window.shared = true;
};

/** Where is a given colour in the newest frame? Returns the frame size and the bounding box of matching pixels. */
window.analyse = async ([r, g, b], tol = 30) => {
  if (!latest) return { error: "no frame yet" };
  const w = latest.width, h = latest.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(latest, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - r) < tol && Math.abs(d[i + 1] - g) < tol && Math.abs(d[i + 2] - b) < tol) {
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { frame: { w, h }, settings, matches: n, bbox: n ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
};
