// After you rebuild, an extension that is already installed loads the new code by itself (no reload arrow),
// and it never does that in the middle of a recording.
//   node test/autoreload.mjs
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
const build = () => spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
build();
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4622", PROXY_PORT: "4623", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow U</title><body style="background:#0a0">`); });
await new Promise((r) => site.listen(5083, "127.0.0.1", r));
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4622/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=SpikeWindow U and", "--auto-accept-camera-and-microphone-capture",
    "--use-fake-device-for-media-stream", "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  await api("setServer", "http://localhost:4622");
  const P = await ctx.newPage();
  await P.goto("http://localhost:5083/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (!(await api("pageState")).error) break; } catch { /* not ready */ } await sleep(150); }
  await api("status"); // the first call reads the version this code was started with
  await sw.evaluate(() => { self.__old = true; });

  // 1. a rebuild with unchanged code: nothing happens
  build();
  await sleep(3300);
  await api("status");
  await sleep(1500);
  check(await sw.evaluate(() => self.__old === true).catch(() => false), "a rebuild that changes nothing does not reload the extension");

  // 2. a rebuild with new code while recording: it waits
  await api("pick");
  await api("start", { micOn: true });
  fs.appendFileSync(path.join(HERE, "..", "src", "offscreen.html"), "\n"); // a real change to the sources
  build();
  await sleep(3300);
  await api("status");
  await sleep(1500);
  check(await sw.evaluate(() => self.__old === true).catch(() => false), "new code is NOT loaded while a recording is running");
  const saved = await api("stop");
  check(!!saved.saved, "and the recording finishes normally", saved.saved?.name ?? saved.error);

  // 3. idle again: the open side panel keeps talking to the extension, which picks the new code up by itself
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  const fresh = await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check(!!fresh, "once idle, the extension loads the rebuilt code by itself (the open panel is enough)");
  if (fresh) {
    sw = fresh;
    check(await sw.evaluate(() => self.__old === undefined), "and it really is a fresh start (new code, old state gone)");
  }
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  // put the source file back exactly as it was
  const f = path.join(HERE, "..", "src", "offscreen.html");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\n$/, ""));
  await ctx.close().catch(() => {});
  server.kill();
  site.close();
  for (const d of [profile, extDir, recDir]) fs.rmSync(d, { recursive: true, force: true });
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
}
