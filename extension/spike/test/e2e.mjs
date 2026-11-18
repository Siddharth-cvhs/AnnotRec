// End-to-end test of the extension spike, in real Microsoft Edge.
//   node test/e2e.mjs
//
// Share the window ONCE, record, freeze + draw on tab A, switch to tab B and draw there, switch back,
// stop. The MP4 (made by our own FFmpeg server) is then analysed frame by frame:
//   - the picture follows the tab in front (green -> blue -> green)
//   - it is only the page: no tab strip, no address bar, no side panel
//   - ink is in the video only while frozen, and in the right tab
//   - there is sound, and the length matches
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
const check = (ok, msg, detail = "") => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`);
};

// ---- build the extension, start our FFmpeg server and two test sites
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "inherit" });
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4600", PROXY_PORT: "4601", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const PAGE = { a: "#00aa00", b: "#0000ff" };
const site = http.createServer((req, res) => {
  const k = req.url.startsWith("/b") ? "b" : "a";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow ${k.toUpperCase()}</title><body style="margin:0;background:${PAGE[k]};color:#fff;font:700 40px system-ui">
    <div style="padding:30px">Tab ${k.toUpperCase()}</div><div id=t style="padding:0 30px;font-size:24px"></div>
    <script>setInterval(()=>t.textContent=new Date().toISOString(),100)</script>`);
});
await new Promise((r) => site.listen(5073, "127.0.0.1", r));
for (let i = 0; i < 40; i++) {
  try { if ((await fetch("http://localhost:4600/api/health")).ok) break; } catch { /* starting */ }
  await sleep(200);
}

// ---- Edge with the extension, a fake microphone, and the window picker answered automatically
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: false,
  timeout: 40000,
  viewport: null,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow A and",
    "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream",
    "--window-size=1300,850",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

// ---- analysis helpers (FFmpeg decodes, we count colours)
const probe = (file) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout || "{}");
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  return { v, a, vd: Number(v?.duration), ad: Number(a?.duration) };
};
const frameAt = (file, t) => {
  const { v } = probe(file);
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: v.width * v.height * 3 + 1e6 });
  return { w: v.width, h: v.height, d: r.stdout };
};
const share = (f, hex, tol = 40, rows) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const y1 = rows ? Math.min(rows, f.h) : f.h;
  let n = 0;
  for (let y = 0; y < y1; y++) for (let x = 0; x < f.w; x++) {
    const i = (y * f.w + x) * 3;
    if (Math.abs(f.d[i] - r) < tol && Math.abs(f.d[i + 1] - g) < tol && Math.abs(f.d[i + 2] - b) < tol) n++;
  }
  return n / (y1 * f.w);
};
const ink = (f) => {
  let n = 0;
  for (let i = 0; i < f.d.length; i += 3) if (f.d[i] > 140 && f.d[i] < 205 && f.d[i + 1] < 135 && f.d[i + 2] > 200) n++;
  return n;
};

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  await api("setServer", "http://localhost:4600");

  const A = await ctx.newPage();
  await A.goto("http://localhost:5073/a");
  await A.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* content script not ready */ } await sleep(150); }

  console.log("\nSetup");
  const shared = await api("pick");
  check(shared.ok === true, "the browser window was shared with one pick", JSON.stringify(shared.settings && { w: shared.settings.width, h: shared.settings.height }));

  const dims = async (p) => p.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const draw = async (p, tool, a, b) => {
    const { w, h } = await dims(p);
    await api("tool", tool, { color: "#a855f7", width: 6 });
    await p.mouse.move(w * a[0], h * a[1]);
    await p.mouse.down();
    await p.mouse.move(w * b[0], h * b[1], { steps: 12 });
    await p.mouse.up();
  };

  const started = await api("start", { micOn: true, codec: process.env.CODEC || "h264", debugRaw: !!process.env.RAW });
  const t0 = started.startedAt; // the recorder's own clock: a busy machine can delay the reply, not the recording
  const at = () => (Date.now() - t0) / 1000;
  check(started.ok === true, "recording started", `${started.codec}: output ${started.out?.w}x${started.out?.h}; page found inside the window at ${JSON.stringify(started.calibration?.page)}`);

  const marks = {};
  const mark = (name) => (marks[name] = at());

  console.log("\nRecording: tab A, then B, then A again");
  await sleep(2500); mark("A live");
  await api("freeze");
  await draw(A, "rect", [0.15, 0.3], [0.6, 0.7]);
  await sleep(2000); mark("A ink");
  const stA = await api("pageState");
  check(stA.frozen && stA.shapes === 1, "page A froze and took a rectangle", JSON.stringify(stA));
  await api("clear");
  await sleep(600);

  const B = await ctx.newPage();
  await B.goto("http://localhost:5073/b");
  await B.bringToFront(); // the picture must follow without any click
  await sleep(2500); mark("B live");
  await api("freeze");
  await draw(B, "arrow", [0.2, 0.7], [0.7, 0.35]);
  await sleep(2000); mark("B ink");
  await api("clear");
  await sleep(600);

  await A.bringToFront();
  await sleep(2500); mark("A again");

  const stopAt = Date.now();
  const saved = await api("stop");
  const stopMs = Date.now() - stopAt;
  if (process.env.RAW && saved.rawBase64) {
    const raw = path.join(path.dirname(process.env.RAW), "raw.webm");
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.writeFileSync(raw, Buffer.from(saved.rawBase64, "base64"));
    console.log("  info  raw recorder output saved: " + raw);
  }
  if (process.env.KEEP) {
    fs.mkdirSync(process.env.KEEP, { recursive: true });
    fs.copyFileSync(path.join(recDir, saved.saved.name), path.join(process.env.KEEP, "spike.mp4"));
    fs.writeFileSync(path.join(process.env.KEEP, "marks.json"), JSON.stringify(marks));
  }
  check(saved.ok === true && saved.saved?.name?.endsWith(".mp4"), "stopped and saved an MP4 through our FFmpeg server", saved.saved?.name);

  console.log("\nThe MP4");
  const file = path.join(recDir, saved.saved.name);
  const p = probe(file);
  check(p.v?.codec_name === "h264" && p.a?.codec_name === "aac", "H.264 + AAC (sound present)", `${p.v?.codec_name}/${p.a?.codec_name}`);
  check(Math.abs(p.vd - saved.durationMs / 1000) < 1.5, "length matches what the recorder ran", `video ${p.vd.toFixed(1)} s, recorder ${(saved.durationMs / 1000).toFixed(1)} s`);
  check(stopMs < 5000, "Stop to a saved MP4 is quick (the server kept up while recording)", `${stopMs} ms`);
  check(Math.abs(p.ad - p.vd) < 0.6, "audio and video lengths match", `${p.ad.toFixed(2)} vs ${p.vd.toFixed(2)}`);
  const vol = spawnSync("ffmpeg", ["-i", file, "-af", "volumedetect", "-vn", "-f", "null", "NUL"], { encoding: "utf8" }).stderr;
  const volMatch = /max_volume: (-?[\d.]+) dB/.exec(vol);
  const maxVol = volMatch ? Number(volMatch[1]) : NaN; // NaN fails the check: never a default that looks like a result
  check(maxVol > -35, "the microphone put real sound in the file (not just an empty track)", `loudest ${maxVol} dB`);
  console.log(`  info  ${p.v.width}x${p.v.height}; compositor drew ${saved.framesDrawn} frames, longest gap between ticks ${saved.maxTickGapMs} ms, window picture delivered ${saved.windowFramesReceived} frames; recorder ran ${(saved.durationMs / 1000).toFixed(1)} s; stop took ${stopMs} ms; mic at the source peaked at ${saved.micPeak} ${JSON.stringify(saved.micState)}`);

  const f = (name, dt = 0) => frameAt(file, marks[name] - 0.9 + dt + 0.2);
  const fAL = f("A live"), fAI = f("A ink"), fBL = f("B live"), fBI = f("B ink"), fA2 = f("A again");
  check(share(fAL, PAGE.a) > 0.6, "tab A in front: the picture is tab A", `green ${(share(fAL, PAGE.a) * 100).toFixed(0)}%`);
  check(ink(fAL) < 50, "no ink before freezing", `${ink(fAL)} px`);
  check(share(fAI, PAGE.a) > 0.4 && ink(fAI) > 600, "tab A frozen: still tab A, with the rectangle", `ink ${ink(fAI)} px`);
  check(share(fBL, PAGE.b) > 0.6 && share(fBL, PAGE.a) < 0.05, "switched to tab B: the picture followed with no click", `blue ${(share(fBL, PAGE.b) * 100).toFixed(0)}%`);
  check(share(fBI, PAGE.b) > 0.4 && ink(fBI) > 400, "tab B frozen: the arrow is in tab B", `ink ${ink(fBI)} px`);
  check(share(fA2, PAGE.a) > 0.6 && share(fA2, PAGE.b) < 0.05 && ink(fA2) < 50, "back on tab A: live again, ink gone", `ink ${ink(fA2)} px`);
  const top = [fAL, fBL, fAI].map((x, i) => share(x, i === 1 ? PAGE.b : PAGE.a, 40, 6));
  check(top.every((s) => s > 0.9), "only the page is recorded: the top rows are page, not tab strip or address bar", top.map((s) => `${(s * 100).toFixed(0)}%`).join(" "));
  const edge = [fAL, fBL].map((x, i) => {
    // right-most columns must be page too (no side panel, no window border)
    let n = 0, tot = 0;
    const col0 = x.w - 6;
    for (let y = 0; y < x.h; y++) for (let c = col0; c < x.w; c++) { const o = (y * x.w + c) * 3; const [r, g, b] = [x.d[o], x.d[o + 1], x.d[o + 2]]; tot++; if (i === 0 ? g > 120 && r < 60 : b > 200 && r < 60) n++; }
    return n / tot;
  });
  check(edge.every((s) => s > 0.9), "the right edge is page too (no window border or side panel)", edge.map((s) => `${(s * 100).toFixed(0)}%`).join(" "));
  const fps = (saved.framesDrawn / (saved.durationMs / 1000));
  check(fps > 20, "the cropping compositor keeps up", `${fps.toFixed(1)} frames per second drawn`);
} catch (e) {
  console.log("  FAIL  test crashed:", e.message.split("\n")[0]);
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
