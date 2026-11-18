// One-off tool: draws the extension icons (src/icons/icon-16|32|48|128.png) with the browser's own canvas.
//   node make-icons.mjs
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const OUT = path.join(HERE, "src", "icons");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent"><canvas id=c width=${size} height=${size}></canvas>`);
  await page.evaluate((s) => {
    const c = document.getElementById("c").getContext("2d");
    const r = s * 0.22;
    const g = c.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, "#5b8cff");
    g.addColorStop(1, "#3f4fd8");
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(0, 0, s, s, r);
    c.fill();
    // a pen stroke
    c.strokeStyle = "#ffffff";
    c.lineWidth = Math.max(1.6, s * 0.09);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(s * 0.2, s * 0.72);
    c.bezierCurveTo(s * 0.35, s * 0.35, s * 0.5, s * 0.85, s * 0.78, s * 0.42);
    c.stroke();
    // the record dot
    c.fillStyle = "#ff4d57";
    c.beginPath();
    c.arc(s * 0.74, s * 0.26, s * 0.14, 0, Math.PI * 2);
    c.fill();
  }, size);
  await page.locator("canvas").screenshot({ path: path.join(OUT, `icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log("icons written to", OUT);
