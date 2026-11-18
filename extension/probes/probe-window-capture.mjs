// Can ONE window pick follow the active tab, and can we find the page area inside the frame?
//   node probe-window-capture.mjs
//
// Shares the Edge window once from an extension page, then switches between a green tab and a blue
// tab and measures, in the captured frames, where the page content really is. It compares that with
// what the page itself reports (window position and sizes), to see if the crop can be computed.
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SRC = path.join(HERE, "probe-win-ext");
const { key, id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(HERE, "..", "spike", "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const b = req.url.startsWith("/b");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>${b ? "BBB" : "AAA"} page</title><body style="margin:0;background:${b ? "#0000ff" : "#00aa00"}"><h1 style="color:#fff">${req.url}</h1>`);
});
await new Promise((r) => server.listen(5072, "127.0.0.1", r));

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-win-ext-"));
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(ext, f));
fs.writeFileSync(
  path.join(ext, "manifest.json"),
  JSON.stringify({ manifest_version: 3, name: "probe window capture", version: "0.0.1", key, permissions: ["tabs"], background: { service_worker: "sw.js" } }),
);
fs.writeFileSync(path.join(ext, "sw.js"), "");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-win-prof-"));

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: false,
  timeout: 40000,
  viewport: null, // use the real window size
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    "--auto-select-desktop-capture-source=capture probe",
    "--window-size=1300,850",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const cap = await ctx.newPage();
  await cap.goto(`chrome-extension://${EXT_ID}/capture.html`);
  await cap.click("#share");
  await cap.waitForFunction(() => window.shared === true || window.shareError, null, { timeout: 20000 });
  const err = await cap.evaluate(() => window.shareError);
  if (err) throw new Error("share failed: " + err);
  console.log("window shared once (one pick).");

  const a = await ctx.newPage();
  await a.goto("http://localhost:5072/a");
  const b = await ctx.newPage();
  await b.goto("http://localhost:5072/b");

  for (const [label, page, rgb] of [["tab A (green)", a, [0, 170, 0]], ["tab B (blue)", b, [0, 0, 255]]]) {
    await page.bringToFront();
    await sleep(1200); // let a fresh frame arrive
    const geo = await page.evaluate(() => ({
      screenX: window.screenX, screenY: window.screenY,
      outerW: window.outerWidth, outerH: window.outerHeight,
      innerW: window.innerWidth, innerH: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    const m = await cap.evaluate((c) => window.analyse(c), rgb);
    console.log(`\n${label} in front:`);
    console.log("  page reports:", JSON.stringify(geo));
    console.log("  captured frame:", JSON.stringify(m.frame), "| content colour found:", m.matches, "px");
    console.log("  content box inside the frame:", JSON.stringify(m.bbox));
    if (m.bbox) {
      const exp = { w: Math.round(geo.innerW * geo.dpr), h: Math.round(geo.innerH * geo.dpr) };
      console.log(`  expected size from innerWidth/Height x dpr: ${exp.w} x ${exp.h}  -> measured ${m.bbox.w} x ${m.bbox.h}`);
    }
  }
} catch (e) {
  console.log("probe failed:", e.message.split("\n")[0]);
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
  server.close();
}
