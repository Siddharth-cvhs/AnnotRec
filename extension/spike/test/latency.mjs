// How fast does it react? Time to freeze a page, and the cost of drawing on a page that already has many shapes.
//   node test/latency.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { BROWSER, launch, launchOptions, SCHEME, PROCESS, extensionWorker, rmQuiet } from "./browser.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const site = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>SpikeWindow L</title><body style="margin:0;font:16px system-ui;background:#fff">${"<p>Some text on the page to make the picture realistic. ".repeat(400)}`);
});
await new Promise((r) => site.listen(5080, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--window-size=1300,850", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  const P = await ctx.newPage();
  await P.goto("http://localhost:5080/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }

  // freeze: time from the command to "the page is frozen and drawable"
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await api("freeze");
    times.push(Date.now() - t);
    await api("clear");
    await sleep(650); // Chrome allows two page pictures per second; people do not freeze faster than that
  }
  times.sort((a, b) => a - b);
  console.log(`  info  freeze takes ${times.join(", ")} ms`);
  // Chrome's own page-picture call is slower than Edge's and Brave's (about 0.3 s), so its limit is wider
  const limit = BROWSER === "chrome" ? 500 : 250;
  check(times[2] < limit, `freezing the page takes under ${limit} ms (median)`, `${times[2]} ms`);

  // drawing: 400 shapes on the page, then one more long stroke; measure frame cost inside the page
  await api("freeze");
  await api("tool", "rect", { color: "#ef4444", width: 3 });
  for (let i = 0; i < 400; i++) {
    const x = 50 + (i % 20) * 50, y = 50 + Math.floor(i / 20) * 30;
    await P.mouse.move(x, y); await P.mouse.down(); await P.mouse.move(x + 30, y + 20); await P.mouse.up();
  }
  await api("tool", "pen", { color: "#22c55e", width: 5 });
  const t0 = Date.now();
  await P.mouse.move(100, 700); await P.mouse.down();
  const frames = P.evaluate(() => new Promise((resolve) => {
    const gaps = []; let last = performance.now(); let n = 0;
    const loop = () => { const now = performance.now(); gaps.push(now - last); last = now; if (++n < 90) requestAnimationFrame(loop); else resolve(gaps); };
    requestAnimationFrame(loop);
  }));
  for (let i = 0; i < 90; i++) { await P.mouse.move(100 + i * 10, 700 + Math.sin(i / 5) * 80); await sleep(8); }
  const gaps = await frames;
  await P.mouse.up();
  const worst = Math.max(...gaps);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`  info  while drawing over 400 shapes: average frame ${avg.toFixed(1)} ms, worst ${worst.toFixed(0)} ms (${Date.now() - t0} ms total)`);
  check(avg < 24, "drawing over 400 shapes keeps the page near 60 fps", `${avg.toFixed(1)} ms per frame`);
  check(worst < 80, "and never freezes for long", `${worst.toFixed(0)} ms worst`);
} finally {
  await ctx.close().catch(() => {});
  site.close();
  for (const d of [profile, extDir]) rmQuiet(d);
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
