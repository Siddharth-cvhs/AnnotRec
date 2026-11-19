// The annotation tools on a real page in Edge: every tool, undo/redo, eraser, shortcuts, Clear All.
//   node test/tools.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { launch, launchOptions, SCHEME, PROCESS, extensionWorker, rmQuiet } from "./browser.mjs";
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
  res.end(`<title>SpikeWindow T</title><body style="margin:0;background:#fff">hello`);
});
await new Promise((r) => site.listen(5076, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--window-size=1200,800", "--no-first-run", "--no-default-browser-check"],
});

try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a), [fn, args]);
  const P = await ctx.newPage();
  await P.goto("http://localhost:5076/t");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { try { if (await api("pageState")) break; } catch { /* not ready */ } await sleep(150); }
  const st = () => api("pageState");
  const drag = async (x1, y1, x2, y2, steps = 8) => {
    await P.mouse.move(x1, y1); await P.mouse.down(); await P.mouse.move(x2, y2, { steps }); await P.mouse.up();
  };

  await api("freeze");
  check((await st()).frozen === true, "freeze puts the page behind the drawing layer");

  let n = 0;
  for (const [tool, y] of [["pen", 100], ["highlighter", 160], ["line", 220], ["arrow", 280], ["rect", 340], ["ellipse", 420]]) {
    await api("tool", tool, { color: "#ef4444", width: 5 });
    await drag(200, y, 500, y + 40);
    n++;
    check((await st()).shapes === n, `${tool} draws a shape`, `${(await st()).shapes} shapes`);
  }

  await api("tool", "marker", { color: "#3b82f6", width: 4 });
  await P.mouse.click(700, 150); await P.mouse.click(760, 150);
  n += 2;
  check((await st()).shapes === n, "marker drops numbered markers", `${(await st()).shapes} shapes`);

  await api("tool", "text", { color: "#22c55e", width: 4 });
  await P.mouse.click(700, 300);
  await P.keyboard.type("Look here");
  await P.keyboard.press("Enter");
  n++;
  check((await st()).shapes === n, "text: click, type, Enter adds the words");

  await api("undo");
  check((await st()).shapes === n - 1 && (await st()).canRedo === true, "undo removes the last shape");
  await api("redo");
  check((await st()).shapes === n, "redo brings it back");
  await P.keyboard.press("Control+z");
  check((await st()).shapes === n - 1, "Ctrl+Z works on the page");
  await P.keyboard.press("Control+Shift+z");
  check((await st()).shapes === n, "Ctrl+Shift+Z works on the page");

  await api("tool", "eraser");
  await P.mouse.click(350, 360); // on the rectangle's edge? the rect spans 200..500 x 340..380: click its top edge
  await P.mouse.click(350, 340);
  check((await st()).shapes === n - 1, "eraser removes the shape you click", `${(await st()).shapes} shapes`);

  await api("tool", "select");
  const before = (await st()).firstShape.pts[0];
  await drag(350, 120, 450, 170);
  const s1 = await st();
  check(s1.selected === true && Math.abs(s1.firstShape.pts[0].x - before.x - 100) < 3 && Math.abs(s1.firstShape.pts[0].y - before.y - 50) < 3, "select picks a shape and drags it where you move", `moved ${(s1.firstShape.pts[0].x - before.x).toFixed(0)},${(s1.firstShape.pts[0].y - before.y).toFixed(0)}`);
  await P.keyboard.press("Delete");
  const s2 = await st();
  check(s2.shapes === n - 2 && s2.selected === false, "Delete removes the selected shape", `${s2.shapes} shapes`);
  await P.mouse.click(900, 700); // empty spot
  check((await st()).selected === false, "clicking empty space selects nothing");

  await P.keyboard.press("b");
  check((await st()).tool === "pen", "the B key switches to the pen");

  await P.keyboard.press("Escape");
  const s = await st();
  check(s.frozen === false && s.shapes === 0, "Esc clears everything and goes live");
} finally {
  await ctx.close().catch(() => {});
  site.close();
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
