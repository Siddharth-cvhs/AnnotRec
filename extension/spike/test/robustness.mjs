// Robustness of the follow-the-tab crop: page zoom and a resized browser window, mid-recording.
//   node test/robustness.mjs
// The page has big white text at its top-left corner. If the crop is right, that text sits near the
// top-left of the video and the page colour fills the picture; if browser UI leaked in, the text would
// be shifted down and other colours would show.
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const ROOT = path.resolve(SPIKE, "..", "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4602", PROXY_PORT: "4603", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow R</title><body style="margin:0;background:#00aa00;color:#fff;font:700 40px system-ui"><div style="padding:30px">Corner text</div>`);
});
await new Promise((r) => site.listen(5075, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4602/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow R and", "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});

const probe = (file) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  const v = JSON.parse(r.stdout).streams.find((s) => s.codec_type === "video");
  return { w: v.width, h: v.height, d: Number(v.duration) };
};
const frameAt = (file, t) => {
  const { w, h } = probe(file);
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: w * h * 3 + 1e6 });
  return { w, h, d: r.stdout };
};
const analyse = (f) => {
  let green = 0, black = 0, x0 = f.w, y0 = f.h, tot = f.w * f.h;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const i = (y * f.w + x) * 3, r = f.d[i], g = f.d[i + 1], b = f.d[i + 2];
    if (g > 120 && r < 60 && b < 60) green++;
    else if (r < 12 && g < 12 && b < 12) black++;
    else if (r > 220 && g > 220 && b > 220) { if (x < x0) x0 = x; if (y < y0) y0 = y; }
  }
  return { greenShare: green / tot, blackShare: black / tot, text: { x: x0, y: y0 } };
};

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  await api("setServer", "http://localhost:4602");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5075/r");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }
  await api("pick");
  const started = await api("start", { micOn: true });
  const t0 = started.startedAt;
  const at = () => (Date.now() - t0) / 1000;
  const marks = {};

  await sleep(2000); marks.normal = at();
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.setZoom(t.id, 1.5); });
  await sleep(2500); marks.zoomed = at();
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.setZoom(t.id, 1); });
  await sleep(1000);
  await sw.evaluate(async () => { const w = await chrome.windows.getLastFocused(); await chrome.windows.update(w.id, { width: 1000, height: 650 }); });
  await sleep(2500); marks.smaller = at();
  await sw.evaluate(async () => { const w = await chrome.windows.getLastFocused(); await chrome.windows.update(w.id, { width: 1300, height: 850 }); });
  await sleep(2500); marks.restored = at();

  const saved = await api("stop");
  const file = path.join(recDir, saved.saved.name);
  const vp = probe(file);
  console.log(`\nVideo ${vp.w}x${vp.h}, ${vp.d.toFixed(1)} s (the picture size is fixed; pages of another shape are letterboxed)`);
  for (const [name, t] of Object.entries(marks)) {
    const a = analyse(frameAt(file, t - 0.8));
    const ok = name === "smaller" || name === "zoomed"
      ? a.greenShare + a.blackShare > 0.97 && a.text.y < 200 // letterboxing allowed: only green page and black bars, text near the top
      : a.greenShare > 0.97 && a.text.y < 90;
    check(ok, `${name}: only the page (green ${(a.greenShare * 100).toFixed(1)}%, black bars ${(a.blackShare * 100).toFixed(1)}%), corner text at y=${a.text.y}`);
  }
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) fs.rmSync(d, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
}
