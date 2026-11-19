// The panel answers at once, and the real work follows: Start shows "Starting…" immediately and "Recording" soon after,
// a tool lights up and freezes the page in one go, Stop shows "Saving…" and then the saved file.
//   node test/ui.mjs
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
  env: { ...process.env, PORT: "4640", PROXY_PORT: "4641", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow I</title><body style="margin:0;background:#0a0;font:30px system-ui;color:#fff">a page`); });
await new Promise((r) => site.listen(5085, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4640/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow I"), "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  await api("setServer", "http://localhost:4640");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5085/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }
  await api("pick"); // the window is shared (a one-time step)
  await sleep(1200);

  // the panel (as a tab, which is how a test reaches it), with the microphone already allowed
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/permission.html`); // grants the microphone, as the first-time flow does
  await panel.waitForFunction(() => document.getElementById("msg").textContent.includes("allowed"), null, { timeout: 8000 });
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById("perm").textContent.includes("Microphone: allowed"), null, { timeout: 8000 });
  await P.bringToFront();

  // ---- Start
  const t0 = Date.now();
  await panel.evaluate(() => document.getElementById("start").click());
  const startingAt = await panel.waitForFunction(() => document.getElementById("recstate").textContent === "Starting…", null, { timeout: 2000, polling: 10 }).then(() => Date.now() - t0, () => -1);
  check(startingAt >= 0 && startingAt < 150, "pressing Start shows \"Starting…\" at once", `${startingAt} ms`);
  const recAt = await panel.waitForFunction(() => document.getElementById("recstate").textContent === "Recording", null, { timeout: 6000, polling: 20 }).then(() => Date.now() - t0, () => -1);
  check(recAt >= 0 && recAt < 1200, "and \"Recording\" follows within 1.2 s", `${recAt} ms`);
  check((await panel.evaluate(() => document.getElementById("start").disabled)) === false, "Start is usable again once it is running");

  // ---- drawing: one press lights the tool and freezes the page
  await sleep(500);
  const t1 = Date.now();
  // pressed and checked in the same moment: the tool must be lit before the click handler even returns
  const litNow = await panel.evaluate(() => { const b = document.querySelector('[data-tool="rect"]'); b.click(); return b.classList.contains("on"); });
  check(litNow === true, "choosing a tool lights it at once (before anything else has answered)");
  let frozenAt = -1;
  for (let i = 0; i < 100 && frozenAt < 0; i++) { if ((await api("pageState")).frozen) frozenAt = Date.now() - t1; else await sleep(10); }
  check(frozenAt >= 0 && frozenAt < 700, "and the page is frozen for drawing within 0.7 s", `${frozenAt} ms`);
  await P.mouse.move(300, 300); await P.mouse.down(); await P.mouse.move(500, 400, { steps: 6 }); await P.mouse.up();
  check((await api("pageState")).shapes === 1, "and drawing works right away");
  await panel.evaluate(() => document.getElementById("clear").click());
  await sleep(300);
  check((await api("pageState")).frozen === false, "Clear all, go live is immediate");

  // ---- Stop
  await sleep(800);
  const t2 = Date.now();
  await panel.evaluate(() => document.getElementById("stop").click());
  const savingAt = await panel.waitForFunction(() => document.getElementById("recstate").textContent === "Saving…", null, { timeout: 2000, polling: 10 }).then(() => Date.now() - t2, () => -1);
  check(savingAt >= 0 && savingAt < 150, "pressing Stop shows \"Saving…\" at once", `${savingAt} ms`);
  const savedAt = await panel.waitForFunction(() => /^Saved/.test(document.getElementById("toasttext").textContent), null, { timeout: 8000, polling: 20 }).then(() => Date.now() - t2, () => -1);
  check(savedAt >= 0 && savedAt < 2000, "and \"Saved ✓\" with the file name follows within 2 s", `${savedAt} ms`);
  check(fs.readdirSync(recDir).some((n) => n.endsWith(".mp4")), "the MP4 is in the recordings folder");
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
