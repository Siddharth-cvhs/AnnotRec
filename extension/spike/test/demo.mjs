// A demo run, the way a presenter would use it: shortcuts, the toolbar badge, the panel's clock and level meter,
// navigating inside a tab while recording, and a clean MP4 at the end.
//   node test/demo.mjs            (SOAK=60 node test/demo.mjs  adds a 60 s endurance run first)
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { launch, launchOptions, SCHEME, PROCESS, extensionWorker, rmQuiet, windowFlag } from "./browser.mjs";
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
  env: { ...process.env, PORT: "4610", PROXY_PORT: "4611", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((q, res) => {
  const blue = q.url.startsWith("/b");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow D</title><body style="margin:0;background:${blue ? "#0000cc" : "#00aa00"}"><a id=go href="/b" style="color:#fff;font:30px system-ui">go</a>`);
});
await new Promise((r) => site.listen(5081, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4610/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow D"), "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
const probe = (file) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  const v = JSON.parse(r.stdout).streams.find((s) => s.codec_type === "video");
  return { w: v.width, h: v.height, d: Number(v.duration) };
};
const colourShare = (file, t, ch) => {
  const { w, h } = probe(file);
  const f = spawnSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: w * h * 3 + 1e6 }).stdout;
  let n = 0, tot = 0;
  for (let i = 0; i < f.length; i += 3 * 97) { tot++; if (ch === "g" ? f[i + 1] > 120 && f[i + 2] < 60 : f[i + 2] > 150 && f[i + 1] < 60) n++; }
  return n / tot;
};

try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const key = (c) => sw.evaluate((c) => self.onCommand(c, null), c);
  await api("setServer", "http://localhost:4610");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5081/a");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }
  await api("pick");

  if (process.env.SOAK) {
    const secs = Number(process.env.SOAK);
    await api("start", { micOn: true });
    await sleep(secs * 1000);
    const r = await api("stop");
    const file = path.join(recDir, r.saved.name);
    const p = probe(file);
    check(Math.abs(p.d - secs) < 3, `a ${secs} s recording comes out ${secs} s long`, `${p.d.toFixed(1)} s, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, longest gap ${r.maxTickGapMs} ms`);
  }

  // the panel, opened as a tab, while recording
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await P.bringToFront();

  check((await badge()) === "", "the toolbar badge is empty when idle");
  await key("toggle-record"); // Alt+Shift+R
  await sleep(1500);
  check((await badge()) === "REC", "Alt+Shift+R starts recording and the badge says REC", await badge());
  await sleep(1500);
  await panel.waitForFunction(() => document.getElementById("recbar").className.includes("rec"), null, { timeout: 5000 });
  const clock = await panel.textContent("#clock");
  check(/^00:0[1-9]$/.test(clock), "the panel shows Recording and a running clock", clock);
  const level = await panel.evaluate(() => parseFloat(document.getElementById("level").style.width));
  check(level > 0, "the level meter moves with the microphone", `${level}%`);

  await sleep(1500); // green
  const tGreen = ((await api("status")).elapsedMs / 1000) - 0.8;
  await key("toggle-pause"); // Alt+Shift+P
  check((await badge()) === "II", "Alt+Shift+P pauses and the badge says II", await badge());
  await key("toggle-pause");
  check((await badge()) === "REC", "pressing it again resumes");

  await key("toggle-draw"); // Alt+Shift+D: freeze
  check((await api("pageState")).frozen === true, "Alt+Shift+D freezes the page for drawing", await sw.evaluate(() => self.lastCommandError ?? ""));
  await P.mouse.move(300, 300); await P.mouse.down(); await P.mouse.move(600, 360, { steps: 10 }); await P.mouse.up();
  await key("toggle-draw"); // and back to live
  check((await api("pageState")).frozen === false, "pressing it again goes live (and clears the drawing)");

  // navigate inside the same tab while recording
  await P.click("#go", { timeout: 5000 });
  await P.waitForURL("**/b", { timeout: 5000 });
  await sleep(2500);
  const tBlue = ((await api("status")).elapsedMs / 1000) - 0.8;
  await key("toggle-record"); // stop
  await sleep(200);
  check((await badge()) === "", "Alt+Shift+R stops and the badge clears", await badge());

  const files = fs.readdirSync(recDir).filter((n) => n.endsWith(".mp4"));
  check(files.length >= 1, "an MP4 was saved", files.join(", "));
  const file = path.join(recDir, files.sort().at(-1));
  check(colourShare(file, tGreen, "g") > 0.8, "the first part shows the green page, full frame", colourShare(file, tGreen, "g").toFixed(2));
  check(colourShare(file, tBlue, "b") > 0.8, "after clicking a link in the same tab the picture stays full frame (blue page)", colourShare(file, tBlue, "b").toFixed(2));
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) rmQuiet(d);
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
