// Pictures of the side panel in its different states, in light and dark, for looking at the design.
//   node test/uxshots.mjs <outputFolder>
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
const OUT = path.resolve(process.argv[2] ?? path.join(SPIKE, "..", "docs"));
fs.mkdirSync(OUT, { recursive: true });
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4650", PROXY_PORT: "4651", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow X</title><body style="margin:0;background:#f5f7fb;font:18px system-ui"><h1 style="padding:30px">Acme Demo Site</h1>`); });
await new Promise((r) => site.listen(5086, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4650/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow X"), "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,900", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  await api("setServer", "http://localhost:4650");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5086/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 1180 });
  const shot = async (name, scheme) => { await panel.emulateMedia({ colorScheme: scheme }); await sleep(450); await panel.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) }); };

  // 1. first run: nothing set up yet
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await sleep(1500);
  await shot("panel-1-setup", "light");
  await shot("panel-1-setup", "dark");

  // 2. microphone allowed and window shared: the setup card folds away
  const perm = await ctx.newPage();
  await perm.goto(`chrome-extension://${EXT_ID}/permission.html`);
  await perm.waitForFunction(() => document.getElementById("msg").textContent.includes("allowed"), null, { timeout: 8000 });
  await perm.emulateMedia({ colorScheme: "dark" }); await sleep(200);
  await perm.screenshot({ path: path.join(OUT, "permission-allowed-dark.png") });
  await P.bringToFront(); // the window title is the title of the tab in front: the picker finds the window by it
  await sleep(700);
  await api("pick");
  await sleep(2200);
  await shot("panel-2-ready", "light");
  await shot("panel-2-ready", "dark");

  // 3. recording, with a tool in use
  await panel.evaluate(() => document.getElementById("start").click());
  await sleep(2600);
  await panel.evaluate(() => document.querySelector('[data-tool="arrow"]').click());
  await sleep(800);
  await shot("panel-3-recording", "light");
  await shot("panel-3-recording", "dark");

  // 4. stopped: the result
  await panel.evaluate(() => document.getElementById("clear").click());
  await sleep(300);
  await panel.evaluate(() => document.getElementById("stop").click());
  await sleep(2500);
  await shot("panel-4-saved", "light");
  await shot("panel-4-saved", "dark");
  console.log("pictures in", OUT);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) rmQuiet(d);
}
