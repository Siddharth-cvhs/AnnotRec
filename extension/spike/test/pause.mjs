// Pause and resume: the paused time is cut from the video, and the picture continues from the page as it is on resume.
//   node test/pause.mjs
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
  env: { ...process.env, PORT: "4604", PROXY_PORT: "4605", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  const blue = _q.url.startsWith("/b");
  res.end(`<title>SpikeWindow P</title><body style="margin:0;background:${blue ? "#0000cc" : "#00aa00"}">`);
});
await new Promise((r) => site.listen(5077, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4604/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow P and", "--auto-accept-camera-and-microphone-capture",
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

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  await api("setServer", "http://localhost:4604");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5077/a");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }
  await api("pick");
  await api("start", { micOn: true });
  await sleep(3000); // green, recorded
  await api("pause");
  const mid = await api("status");
  check(mid.paused === true && mid.recording === true, "status says paused while still recording");
  await P.goto("http://localhost:5077/b"); // changes while paused: must not appear in the middle of the video
  await sleep(4000);
  const during = await api("status");
  check(Math.abs(during.elapsedMs - mid.elapsedMs) < 400, "the clock stands still while paused", `${mid.elapsedMs} -> ${during.elapsedMs} ms`);
  await api("resume");
  await sleep(3000); // blue, recorded
  const saved = await api("stop");
  const file = path.join(recDir, saved.saved.name);
  const vp = probe(file);
  check(vp.d > 5.0 && vp.d < 7.6, "the video is about 6 s long, not 10 (the paused 4 s are cut)", `${vp.d.toFixed(1)} s`);
  const share = (t, ch) => { const f = frameAt(file, t); let n = 0; for (let i = 0; i < f.d.length; i += 3 * 97) if (ch === "g" ? f.d[i + 1] > 120 && f.d[i + 2] < 60 : f.d[i + 2] > 150 && f.d[i + 1] < 60) n++; return n / (f.d.length / (3 * 97)); };
  check(share(1.5, "g") > 0.8, "before the pause the video shows the green page", `${share(1.5, "g").toFixed(2)}`);
  check(share(vp.d - 1, "b") > 0.8, "after resuming it shows the blue page", `${share(vp.d - 1, "b").toFixed(2)}`);
  check(Math.abs(saved.durationMs - vp.d * 1000) < 900, "the recorder's own length matches the video", `${saved.durationMs} ms vs ${(vp.d * 1000).toFixed(0)} ms`);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
}
const ok = results.filter(Boolean).length;
console.log(`
${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
