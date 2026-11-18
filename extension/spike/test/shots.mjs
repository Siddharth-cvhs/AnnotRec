// Takes pictures of the extension for the docs: the side panel, and a page with annotations drawn on it.
//   node test/shots.mjs [outputFolder]     (default: extension/docs)
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const OUT = path.resolve(process.argv[2] ?? path.join(SPIKE, "..", "docs"));
fs.mkdirSync(OUT, { recursive: true });
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>Acme Demo Site</title><body style="margin:0;font:16px system-ui;background:#f5f7fb;color:#1c2333">
  <header style="background:#fff;padding:18px 40px;border-bottom:1px solid #dde2ee;font-weight:700">Acme Demo Site</header>
  <main style="padding:40px;max-width:900px"><h1>Quarterly overview</h1>
  <p>Orders grew steadily this quarter. The chart below shows the trend.</p>
  <div style="display:flex;gap:16px;margin-top:24px">
   <div style="flex:1;background:#fff;border-radius:12px;padding:20px">Orders<br><b style="font-size:32px">1,284</b></div>
   <div style="flex:1;background:#fff;border-radius:12px;padding:20px">Revenue<br><b style="font-size:32px">$48.2k</b></div>
   <div style="flex:1;background:#fff;border-radius:12px;padding:20px">Returns<br><b style="font-size:32px">2.1%</b></div></div></main>`);
});
await new Promise((r) => site.listen(5078, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000, viewport: { width: 1100, height: 700 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  const P = await ctx.newPage();
  await P.goto("http://localhost:5078/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }

  // 1. the page with annotations
  await api("freeze");
  await api("tool", "highlighter", { color: "#facc15", width: 4 });
  await P.mouse.move(80, 175); await P.mouse.down(); await P.mouse.move(520, 178, { steps: 12 }); await P.mouse.up();
  await api("tool", "arrow", { color: "#ef4444", width: 5 });
  await P.mouse.move(700, 330); await P.mouse.down(); await P.mouse.move(380, 285, { steps: 12 }); await P.mouse.up();
  await api("tool", "ellipse", { color: "#a855f7", width: 4 });
  await P.mouse.move(60, 250); await P.mouse.down(); await P.mouse.move(330, 360, { steps: 12 }); await P.mouse.up();
  await api("tool", "text", { color: "#22c55e", width: 5 });
  await P.mouse.click(720, 340);
  await P.keyboard.type("Orders up 12%");
  await P.keyboard.press("Enter");
  await api("tool", "marker", { color: "#3b82f6", width: 4 });
  await P.mouse.click(60, 250);
  await api("tool", "select");
  await P.mouse.click(330, 300);
  await sleep(300);
  await P.screenshot({ path: path.join(OUT, "annotated-page.png") });
  await api("clear");

  // 2. the side panel (opened as a normal tab so it can be photographed)
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 760 });
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await sleep(700);
  await panel.screenshot({ path: path.join(OUT, "side-panel.png") });
  console.log("saved to", OUT);
} finally {
  await ctx.close().catch(() => {});
  site.close();
}
