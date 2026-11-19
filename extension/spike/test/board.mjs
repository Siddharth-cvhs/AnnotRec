// Browser pages (new tab, settings, the extension store) cannot run AnnotRec's code. Drawing on them works through a
// "board": a tab of ours with a picture of the page. This tests the whole round trip.
//   node test/board.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BROWSER, SCHEME, launch, launchOptions, extensionWorker, rmQuiet, windowFlag } from "./browser.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow B</title><body style="margin:0;background:#00aa00">`); });
await new Promise((r) => site.listen(5087, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    windowFlag("SpikeWindow B"), "--window-size=1200,800", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  const tabs = () => sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || "", active: t.active, w: t.width, h: t.height }))));
  const P = await ctx.newPage();
  await P.goto("http://localhost:5087/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }

  // 1. a browser page while the window is NOT shared: a clear, helpful message (nothing half-done)
  await P.goto(`${SCHEME}://version`).catch(() => {});
  await sleep(600);
  const early = await api("draw", "pen", { color: "#a855f7", width: 5 });
  check(/share the window first/i.test(early.error ?? ""), "on a browser page without a shared window it says what to do", (early.error ?? "").slice(0, 70));
  check(!(await tabs()).some((t) => /board\.html/.test(t.url)), "and opens nothing");
  const ps = await api("panelState");
  check(ps.page?.restricted === true, "the panel is told this is a browser page (so it can explain instead of showing an error)");

  // 2. share while a normal page is open, then go back to the browser page
  await P.goto("http://localhost:5087/");
  await sleep(600);
  await api("pick");
  await sleep(1500);
  await P.goto(`${SCHEME}://version`).catch(() => {});
  await sleep(800);
  const before = (await tabs()).filter((t) => t.active)[0];

  // 3. pressing a tool opens the board with a picture of the page, and drawing works
  const r = await api("draw", "rect", { color: "#a855f7", width: 5 });
  check(!r.error, "pressing a tool on a browser page works now", r.error ?? "");
  await sleep(500);
  const ts = await tabs();
  const board = ts.find((t) => /board\.html/.test(t.url));
  check(!!board && board.active, "a drawing board tab opened and is in front", board?.url.slice(-40));
  const st = await api("pageState");
  check(st.frozen === true, "the page is frozen for drawing on the board");
  const boardPage = ctx.pages().find((p) => /board\.html/.test(p.url()));
  const dims = await boardPage.evaluate(() => { const i = document.getElementById("shot"); return { nw: i.naturalWidth, nh: i.naturalHeight, vw: innerWidth, vh: innerHeight }; });
  check(dims.nw > 200 && dims.nh > 200, "the board shows a picture of the page", `${dims.nw}x${dims.nh}`);
  const ratioPic = dims.nw / dims.nh, ratioView = dims.vw / dims.vh;
  check(Math.abs(ratioPic - ratioView) / ratioView < 0.03, "and the picture has the page's shape", `${ratioPic.toFixed(3)} vs ${ratioView.toFixed(3)}`);
  await boardPage.mouse.move(200, 200); await boardPage.mouse.down(); await boardPage.mouse.move(420, 320, { steps: 8 }); await boardPage.mouse.up();
  check((await api("pageState")).shapes === 1, "drawing on it works");

  // 4. Clear all: the board closes and the real browser page is back in front
  await api("clear");
  await sleep(700);
  const after = await tabs();
  check(!after.some((t) => /board\.html/.test(t.url)), "Clear all closes the board");
  const front = after.find((t) => t.active && !/chrome-extension/.test(t.url));
  check(!!front && front.id === before.id && /^(brave|chrome|edge):\/\/version/.test(front.url), "and the browser page you were on is in front again", front?.url);

  // 5. the Esc key on the board does the same
  await api("draw", "pen", {});
  await sleep(500);
  const bp2 = ctx.pages().find((p) => /board\.html/.test(p.url()));
  await bp2.keyboard.press("Escape");
  await sleep(900);
  check(!(await tabs()).some((t) => /board\.html/.test(t.url)), "Esc on the board closes it too");
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  site.close();
  for (const d of [profile, extDir]) rmQuiet(d);
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
}
