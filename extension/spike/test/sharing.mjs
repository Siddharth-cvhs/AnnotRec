// Knowing what is shared: the panel names it, a short quiet notice appears when sharing starts, and the page shows a
// light frame at its edge while sharing / recording (which must never end up in the video).
//   node test/sharing.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launch, launchOptions, extensionWorker, rmQuiet, windowFlag } from "./browser.mjs";

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
  env: { ...process.env, PORT: "4660", PROXY_PORT: "4661", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
// a blue page: a leaked red or blue frame at its edge would show against it
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow N</title><body style="margin:0;background:#00aa00">`); });
await new Promise((r) => site.listen(5088, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4660/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow N"), "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  const popups = () => sw.evaluate(() => chrome.windows.getAll({ populate: true, windowTypes: ["popup"] }).then((ws) => ws.filter((w) => w.tabs?.some((t) => /sharing\.html/.test(t.url || t.pendingUrl || ""))).length));
  await api("setServer", "http://localhost:4660");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5088/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }

  check((await api("pageState")).indicator === "", "before sharing there is no frame on the page");
  const shared = await api("pick", { announce: true });
  check(shared.surface === "window", "the share is recognised as a browser window", shared.surface);
  let seen = 0;
  for (let i = 0; i < 20 && !seen; i++) { seen = await popups(); if (!seen) await sleep(100); }
  check(seen === 1, "a brief notice appears when sharing starts");
  await sleep(3600);
  check((await popups()) === 0, "and goes away by itself", `${await popups()} left`);

  const st = await api("status");
  check(st.share?.surface === "window" && st.share.width > 300, "the status names what is shared (kind and size)", JSON.stringify(st.share));
  await sleep(700);
  check((await api("pageState")).indicator.includes("on"), "the page shows a light frame at its edge while sharing");

  // the same pick without a person pressing it (automated) shows no notice
  const quiet = await api("pick");
  await sleep(1000);
  check((await popups()) === 0 && !quiet.error, "no notice appears when sharing is started by a script");

  // recording: the frame changes (and is NOT in the video)
  await api("setPrefs", { announce: true });
  await api("start", { micOn: true });
  await sleep(1200);
  check((await api("pageState")).indicator.includes("rec"), "while recording the frame turns red");
  await sleep(1800);
  const saved = await api("stop");
  await sleep(600);
  check((await api("pageState")).indicator.includes("on") && !(await api("pageState")).indicator.includes("rec"), "after Stop it goes back to the quiet frame");

  const file = path.join(recDir, saved.saved.name);
  const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" }).stdout).streams[0];
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "1.2", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: probe.width * probe.height * 3 + 1e6 }).stdout;
  let green = 0, tot = 0;
  const W = probe.width, H = probe.height;
  const isGreen = (i) => raw[i + 1] > 120 && raw[i] < 60 && raw[i + 2] < 60;
  for (let x = 0; x < W; x++) for (const y of [0, 1, 2, H - 3, H - 2, H - 1]) { tot++; if (isGreen((y * W + x) * 3)) green++; }
  for (let y = 0; y < H; y++) for (const x of [0, 1, 2, W - 3, W - 2, W - 1]) { tot++; if (isGreen((y * W + x) * 3)) green++; }
  check(green / tot > 0.97, "the frame is not in the video: the outer rows and columns are all page", `${(100 * green / tot).toFixed(1)}% page`);

  // the choice can be switched off
  await api("setPrefs", { indicator: false });
  await sleep(600);
  check((await api("pageState")).indicator === "", "the light frame can be switched off in the settings");
  await api("setPrefs", { indicator: true });

  // the panel names the share
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById("winline").textContent.startsWith("Shared"), null, { timeout: 8000 });
  check(/Browser window/.test(await panel.textContent("#winline")), "the panel says \"Browser window\" and its size", (await panel.textContent("#winline")).slice(0, 60));
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) rmQuiet(d);
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
}
