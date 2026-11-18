// How smooth and how cheap is recording? An animated page is recorded for 10 s and the result is measured.
//   node test/perf.mjs
// Reports: pictures per second delivered by the window capture, drawn by the recorder, and found in the MP4;
// the longest gap between pictures; CPU used by the whole browser while recording (percent of the whole machine).
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
  env: { ...process.env, PORT: "4608", PROXY_PORT: "4609", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
// A busy page: something moves on every frame (a square, a scrolling list and a CSS animation).
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow F</title><body style="margin:0;background:#101624;color:#fff;font:20px system-ui;overflow:hidden">
  <canvas id=c width=1200 height=700 style="display:block"></canvas>
  <script>const c=document.getElementById("c").getContext("2d");let t=0;
  (function f(){t++;c.fillStyle="#101624";c.fillRect(0,0,1200,700);
   for(let i=0;i<12;i++){c.fillStyle="hsl("+((t*3+i*30)%360)+",80%,60%)";c.fillRect(60+((t*7+i*90)%1000),40+i*50,120,30);}
   c.fillStyle="#fff";c.font="28px system-ui";c.fillText("frame "+t,40,680);requestAnimationFrame(f)})()</script>`);
});
await new Promise((r) => site.listen(5079, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4608/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow F and", "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});

// CPU seconds used so far by every browser process of this test (matched by its profile folder's unique name)
const leaf = path.basename(profile);
const cpuSample = () => {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${leaf}*' } | ForEach-Object { ($_.KernelModeTime + $_.UserModeTime) / 1e7 } | Measure-Object -Sum).Sum`;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout.trim();
  return { cpu: Number(out) || 0, t: Date.now() };
};
const cpuBetween = (a, b) => (b.cpu - a.cpu) / ((b.t - a.t) / 1000); // cores in use on average

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  await api("setServer", "http://localhost:4608");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5079/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }
  await api("pick");
  await sleep(500);
  const i0 = cpuSample();
  await sleep(5000);
  const idleCpu = cpuBetween(i0, cpuSample());

  await api("start", { micOn: true });
  const c0 = cpuSample();
  await sleep(10000);
  const c1 = cpuSample();
  const busy = cpuBetween(c0, c1);
  const saved = await api("stop");
  const file = path.join(recDir, saved.saved.name);
  const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", file], { encoding: "utf8" }).stdout).streams[0];
  const secs = saved.durationMs / 1000;
  const cores = os.cpus().length;
  const r = {
    capture: saved.windowFramesReceived / secs,
    drawn: saved.framesDrawn / secs,
    inFile: Number(probe.nb_read_frames) / secs,
  };
  console.log(`  info  ${probe.width}x${probe.height}, ${secs.toFixed(1)} s | window capture ${r.capture.toFixed(1)} fps, drawn ${r.drawn.toFixed(1)} fps, in the MP4 ${r.inFile.toFixed(1)} fps | longest gap ${saved.maxTickGapMs} ms | stop ${"-"}`);
  console.log(`  info  CPU: browser idle sharing ${(100 * idleCpu / cores).toFixed(1)}%, while recording ${(100 * busy / cores).toFixed(1)}% of this ${cores}-core machine (${busy.toFixed(2)} cores)`);
  check(r.inFile >= 24, "the MP4 has at least 24 pictures per second of a moving page", `${r.inFile.toFixed(1)} fps`);
  check(saved.maxTickGapMs < 120, "no stall longer than 120 ms while recording", `${saved.maxTickGapMs} ms`);
  check(100 * busy / cores < 25, "recording costs under 25% of the whole machine", `${(100 * busy / cores).toFixed(1)}%`);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) fs.rmSync(d, { recursive: true, force: true });
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
