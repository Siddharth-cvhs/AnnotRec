// Debug: what does the shared picture look like? Saves it to a file.
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { launch, launchOptions, SCHEME, PROCESS, extensionWorker, rmQuiet } from "./browser.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow A</title><body style="margin:0;background:#00aa00"><h1 style="color:#fff">A</h1>`); });
await new Promise((r) => site.listen(5074, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-peekprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    `--auto-select-desktop-capture-source=${process.env.SRC ?? "SpikeWindow A and"}`, "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...a) => sw.evaluate(([f, x]) => self.api[f](...x), [fn, a]);
  const A = await ctx.newPage(); await A.goto("http://localhost:5074/a"); await A.bringToFront(); await sleep(1500);
  const titles = spawnSync("powershell", ["-NoProfile", "-File", path.join(HERE, "titles.ps1")], { encoding: "utf8" }).stdout;
  console.log("Edge window titles right now (invisible characters shown as <U+XXXX>):\n" + titles);
  const p = await api("pick");
  console.log("picked:", JSON.stringify({ label: p.label, surface: p.settings?.displaySurface, w: p.settings?.width, h: p.settings?.height }));
  await sleep(1200);
  const k = await api("peek");
  fs.writeFileSync(out, Buffer.from(k.jpegBase64, "base64"));
  console.log("frame", k.w, "x", k.h, "->", out);
} catch (e) { console.log("failed:", e.message.split("\n")[0]); }
finally { await ctx.close().catch(() => {}); site.close(); for (const d of [profile, extDir]) rmQuiet(d); }
