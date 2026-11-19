// How long does Start take, and where does the time go?  node test/startlatency.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BROWSER, launch, launchOptions, extensionWorker, rmQuiet, windowFlag } from "./browser.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const ROOT = path.resolve(SPIKE, "..", "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4630", PROXY_PORT: "4631", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow S</title><body style="margin:0;background:#0a0;font:30px system-ui;color:#fff">a page`); });
await new Promise((r) => site.listen(5084, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4630/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow S"), "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  await api("setServer", "http://localhost:4630");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5084/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }
  await api("pick");
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const t = Date.now();
    const r = await api("start", { micOn: true });
    const total = Date.now() - t;
    runs.push({ total, r });
    await sleep(1200);
    await api("stop");
    await sleep(300);
  }
  for (const { total, r } of runs) console.log(`  info  Start took ${total} ms  ${JSON.stringify(r.timings)}`);
  const first = runs[0].total, later = median(runs.slice(1).map((x) => x.total));
  console.log(`  info  first Start ${first} ms, later Starts (median) ${later} ms`);
  check(first < 600, "the first Start (including the one-time warm-up) takes under 0.6 s", `${first} ms`);
  check(later < 300, "later Starts take under 0.3 s", `${later} ms`);
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
