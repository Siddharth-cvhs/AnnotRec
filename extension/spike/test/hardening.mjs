// What happens when things go wrong: the server is not running, the share is stopped mid-recording,
// the server address is wrong or unsafe, the page cannot be drawn on.
//   node test/hardening.mjs
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
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow H</title><body style="margin:0;background:#00aa00">hello`);
});
await new Promise((r) => site.listen(5082, "127.0.0.1", r));
let server = null;
const startServer = async () => {
  server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, PORT: "4620", PROXY_PORT: "4621", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4620/api/health")).ok) return; } catch { /* starting */ } await sleep(200); }
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow H and", "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);

  // --- the server address: only this computer is accepted
  const bad = await api("setServer", "http://evil.example.com:4000");
  check(/this computer/.test(bad.error ?? ""), "a server address outside this computer is refused", bad.error);
  const junk = await api("setServer", "not a url");
  check(/valid address/.test(junk.error ?? ""), "a malformed address is refused", junk.error);
  const good = await api("setServer", "http://localhost:4620/some/path");
  check(good.server === "http://localhost:4620", "a localhost address is saved (reduced to its origin)", good.server);

  const P = await ctx.newPage();
  await P.goto("http://localhost:5082/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (!(await api("pageState")).error) break; } catch { /* not ready */ } await sleep(150); }
  await api("pick");

  // --- the server is not running: a clear message, and nothing is left capturing
  const down = await api("start", { micOn: true });
  check(/Cannot reach the AnnotRec server/.test(down.error ?? ""), "Start with the server down says so, in plain words", (down.error ?? "").slice(0, 80));
  const st0 = await api("status");
  check(st0.recording === false && st0.micOn === null, "and nothing is left recording or holding the microphone");

  // --- the server is up: a normal recording, then the user presses "Stop sharing" in the middle of it
  await startServer();
  const started = await api("start", { micOn: true });
  check(!started.error, "with the server up, Start works", started.error ?? "");
  await sleep(2500);
  await sw.evaluate(() => chrome.runtime.sendMessage({ target: "offscreen", type: "simulateShareEnded" }));
  await sleep(3500);
  const st1 = await api("status");
  check(st1.recording === false, "ending the window share stops the recording by itself");
  const files = fs.readdirSync(recDir).filter((n) => n.endsWith(".mp4"));
  check(files.length === 1 && fs.statSync(path.join(recDir, files[0])).size > 10000, "and what was recorded is saved, not lost", files.join(", "));
  const ended = await sw.evaluate(() => chrome.storage.local.get("lastEnded").then((x) => x.lastEnded ?? null));
  check(ended && /share ended/i.test(ended.reason) && ended.name === files[0], "the reason and the file are remembered for the panel", ended?.reason);
  check((await sw.evaluate(() => chrome.action.getBadgeText({}))) === "!", "the toolbar badge shows !");

  // --- the panel, with an edge:// page in front (which cannot be drawn on), explains instead of failing
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  const browserPage = await ctx.newPage(); // an edge:// page: extensions cannot run code on it
  await browserPage.goto("edge://version").catch(() => {});
  await browserPage.bringToFront();
  await panel.waitForFunction(() => !document.getElementById("pagehint").hidden, null, { timeout: 8000 });
  check(true, "on a page that cannot be drawn on, the panel says so", (await panel.textContent("#pagehint")).slice(0, 60));
  check(/share ended/i.test(await panel.textContent("#toasttext")), "and it tells you the recording stopped because the share ended");
  await panel.click("summary"); // open Settings
  await panel.fill("#server", "http://example.org");
  await panel.click("#saveserver");
  await panel.waitForFunction(() => document.getElementById("err").textContent.includes("this computer"), null, { timeout: 4000 });
  check(true, "an unsafe server address typed in the settings is refused with a reason");
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  server?.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) fs.rmSync(d, { recursive: true, force: true });
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
}
