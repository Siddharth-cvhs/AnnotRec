// Performance measurements in real Edge:
//   node scripts/perf.mjs
// Own server on other ports; prints a table. No assertions on speed beyond
// loose sanity limits, so it stays useful across machines.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4400;
const REC = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-perf-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PROXY_PORT: String(PORT + 1), REC_DIR: REC },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break;
  } catch {
    /* starting */
  }
  await sleep(200);
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
  args: [
    "--auto-accept-this-tab-capture",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const rows = [];
const row = (name, value, note = "") => {
  rows.push([name, value, note]);
  console.log(`${name.padEnd(46)} ${String(value).padEnd(16)} ${note}`);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 820 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("annotrecTest", "1");
    localStorage.setItem("annotrec.settings.v2", JSON.stringify({ countdown: 0 }));
    window.__long = 0;
    new PerformanceObserver((l) => (window.__long += l.getEntries().length)).observe({ entryTypes: ["longtask"] });
  });

  // ------------------------------------------------------------------ load
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}`);
  await page.frameLocator("iframe").getByText("Acme Demo Site").waitFor();
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const res = performance.getEntriesByType("resource").filter((r) => r.name.includes("/assets/"));
    return {
      dcl: Math.round(n.domContentLoadedEventEnd),
      load: Math.round(n.loadEventEnd),
      fcp: Math.round(fcp?.startTime ?? 0),
      kb: Math.round(res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize), 0) / 1024),
    };
  });
  row("Load: first contentful paint", `${nav.fcp} ms`);
  row("Load: DOM ready / window load", `${nav.dcl} / ${nav.load} ms`);
  row("Load: app code + CSS transferred", `${nav.kb} KB`);
  row("Load: until sample page visible", `${Date.now() - t0} ms`, "includes iframe + proxy round trip");

  // ---------------------------------------------------------- freeze latency
  // First freeze includes the one-time "share this tab" session.
  const T = (id) => page.getByTestId(id);
  let t = Date.now();
  await T("tool-pen").click();
  await T("frozen-badge").waitFor();
  row("Freeze: first (includes tab-share setup)", `${Date.now() - t} ms`);
  await T("clear").click();
  const lat = [];
  for (let i = 0; i < 7; i++) {
    t = Date.now();
    await T("tool-pen").click();
    await T("frozen-badge").waitFor();
    lat.push(Date.now() - t);
    await T("clear").click();
    await sleep(150);
  }
  row("Freeze: tool click to frozen page", `${median(lat)} ms`, `median of 7, worst ${Math.max(...lat)} ms`);

  // ------------------------------------------------------------- drawing
  await T("tool-pen").click();
  await T("frozen-badge").waitFor();
  const box = await T("overlay-canvas").boundingBox();
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const loop = (now) => {
      window.__frames.push(now - last);
      last = now;
      window.__raf = requestAnimationFrame(loop);
    };
    window.__raf = requestAnimationFrame(loop);
  });
  const long0 = await page.evaluate(() => window.__long);
  await page.mouse.move(box.x + 50, box.y + 100);
  await page.mouse.down();
  const N = 600;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    await page.mouse.move(box.x + 50 + (i / N) * (box.width - 100), box.y + box.height / 2 + Math.sin(i / 12) * 120);
  }
  await page.mouse.up();
  const drawMs = Date.now() - t1;
  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames.slice(2);
  });
  const long1 = await page.evaluate(() => window.__long);
  row("Draw: one 600-point stroke, frame interval", `${median(frames).toFixed(1)} ms`, `p95 ${pct(frames, 0.95).toFixed(1)} ms, worst ${Math.max(...frames).toFixed(0)} ms`);
  row("Draw: long tasks (>50 ms) during stroke", long1 - long0, `${drawMs} ms for ${N} events`);
  await T("clear").click();

  // ------------------------------------------------- idle cost of recording
  await T("start").click();
  await page.getByTestId("phase").filter({ hasText: "RECORDING" }).waitFor({ timeout: 20000 });
  await sleep(1000);
  const mut = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const panel = document.querySelector("[data-testid=toolbar]");
        let n = 0;
        const mo = new MutationObserver((m) => (n += m.length));
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        const l0 = window.__long;
        const h0 = performance.memory?.usedJSHeapSize ?? 0;
        setTimeout(() => {
          mo.disconnect();
          resolve({ n, long: window.__long - l0, dh: ((performance.memory?.usedJSHeapSize ?? 0) - h0) / 1e6, panel: !!panel });
        }, 8000);
      }),
  );
  row("Recording idle: DOM mutations per second", (mut.n / 8).toFixed(1), "timer text + mic meter bars only");
  row("Recording idle: long tasks in 8 s", mut.long);
  row("Recording idle: JS heap change in 8 s", `${mut.dh.toFixed(1)} MB`);

  // drawing while recording
  await T("tool-pen").click();
  await T("frozen-badge").waitFor();
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const loop = (now) => {
      window.__frames.push(now - last);
      last = now;
      window.__raf = requestAnimationFrame(loop);
    };
    window.__raf = requestAnimationFrame(loop);
  });
  await page.mouse.move(box.x + 50, box.y + 100);
  await page.mouse.down();
  for (let i = 0; i < N; i++) {
    await page.mouse.move(box.x + 50 + (i / N) * (box.width - 100), box.y + box.height / 2 + Math.sin(i / 12) * 120);
  }
  await page.mouse.up();
  const rframes = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames.slice(2);
  });
  row("Draw while recording: frame interval", `${median(rframes).toFixed(1)} ms`, `p95 ${pct(rframes, 0.95).toFixed(1)} ms, worst ${Math.max(...rframes).toFixed(0)} ms`);

  // ---------------------------------------------- stop to saved MP4 time
  await T("clear").click();
  await sleep(1500);
  t = Date.now();
  await T("stop").click();
  await page.getByTestId("phase").filter({ hasText: "READY" }).waitFor({ timeout: 90000 });
  const stopMs = Date.now() - t;
  const dur = await page.evaluate(() => document.querySelector("[data-testid=file] small")?.textContent ?? "");
  row("Save: Stop pressed to MP4 ready", `${stopMs} ms`, `clip: ${dur.split("·").slice(1).join("·").trim()}`);
  await ctx.close();
} catch (e) {
  console.error("perf failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  fs.writeFileSync(path.join(ROOT, "scripts", "last-perf.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  try {
    fs.rmSync(REC, { recursive: true, force: true });
  } catch {
    /* temp */
  }
}
