// Scenario suite for AnnotRec 2.0.
//
//   node scripts/scenarios.mjs [--long] [--only=U05,S03]
//
// Starts its own server (other ports, its own recordings folder) and a hostile
// test app, then drives real Microsoft Edge windows. Every recording is
// analysed pixel by pixel with FFmpeg: ink must be in the video exactly while
// the page is frozen, the toolbar must not be, the audio must match the video.

import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PassThrough } from "node:stream";
import { createAnnotRec } from "../server/src/annotrec.js";
import { FileStorage } from "../server/src/storage.js";
import { startTestApp } from "./testapp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4100;
const PROXY = 4101;
const TARGET_PORT = 5055;
const BASE = `http://localhost:${PORT}`;
const REC = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-test-"));
const ARGS = process.argv.slice(2);
const LONG = ARGS.includes("--long");
const ONLY = (ARGS.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const results = [];
const consoleErrors = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(actual, expected, tol, what) {
  assert(Math.abs(actual - expected) <= tol, `${what}: expected ${expected} ±${tol}, got ${actual}`);
}

// --------------------------------------------------------------- media helpers

function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout || "{}");
  const video = j.streams?.find((s) => s.codec_type === "video");
  const audio = j.streams?.find((s) => s.codec_type === "audio");
  return { video, audio, vd: Number(video?.duration), ad: Number(audio?.duration) };
}

/** The frame at `t` seconds as raw RGB. */
function frameAt(file, t) {
  const { video } = probe(file);
  const w = video.width;
  const h = video.height;
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    maxBuffer: w * h * 3 + 1e6,
  });
  return { w, h, data: r.stdout };
}

/** Purple ink (#a855f7) pixels: nothing else in the test pages is purple. */
function ink(frame) {
  let n = 0;
  let minX = frame.w, minY = frame.h, maxX = -1, maxY = -1;
  const d = frame.data;
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      const i = (y * frame.w + x) * 3;
      if (d[i] > 140 && d[i] < 205 && d[i + 1] < 135 && d[i + 2] > 200) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { n, minX, minY, maxX, maxY, w: frame.w, h: frame.h };
}

/** Share of pixels near the given colour. */
function colorShare(frame, [r, g, b], tol = 40) {
  let n = 0;
  const d = frame.data;
  for (let i = 0; i < d.length; i += 3) {
    if (Math.abs(d[i] - r) < tol && Math.abs(d[i + 1] - g) < tol && Math.abs(d[i + 2] - b) < tol) n++;
  }
  return n / (d.length / 3);
}

// ----------------------------------------------------------------- harness

let browser;
let serverProc;
let targetServer;

async function startServer() {
  serverProc = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PROXY_PORT: String(PROXY), REC_DIR: REC },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("The test server did not start.");
}

const EDGE_ARGS = [
  "--auto-accept-this-tab-capture",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  // The test windows sit behind other windows; keep them rendering (and capturing).
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

/** A fresh browser context + page on the app. */
async function openApp({ dpr = 1, width = 1480, height = 820, init = "", settings = { countdown: 0 }, skipWait = false, url = BASE } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(
    ([s, extra]) => {
      localStorage.setItem("annotrecTest", "1");
      if (s && !localStorage.getItem("annotrec.settings.v2")) localStorage.setItem("annotrec.settings.v2", JSON.stringify(s));
      // eslint-disable-next-line no-eval
      if (extra) eval(extra);
    },
    [settings, init],
  );
  await page.goto(url);
  const frame = page.frameLocator("iframe");
  if (!skipWait) await frame.getByText("Acme Demo Site").waitFor();
  return { ctx, page, frame, errors };
}

const T = (page, id) => page.getByTestId(id);
const phase = (page, text) => T(page, "phase").filter({ hasText: text });

async function startRec(page) {
  await T(page, "start").click();
  await phase(page, "RECORDING").waitFor({ timeout: 20000 });
}

async function stopRec(page) {
  await T(page, "stop").click();
  await phase(page, "READY").waitFor({ timeout: 90000 });
}

/** The newest saved file with this extension, downloaded to the temp folder. */
async function latest(page, ext) {
  const files = await (await page.request.get(`${BASE}/api/recordings`)).json();
  const f = files.find((x) => x.name.endsWith(ext));
  assert(f, `no ${ext} file was saved`);
  const body = await (await page.request.get(`${BASE}/api/recordings/${f.name}`)).body();
  const out = path.join(REC, `copy-${f.name}`);
  fs.writeFileSync(out, body);
  return { ...f, path: out };
}

/** Empties the test library through the API so a scenario starts from nothing. */
async function clearFiles() {
  const files = await (await fetch(`${BASE}/api/recordings`)).json();
  for (const f of files) await fetch(`${BASE}/api/recordings/${f.name}`, { method: "DELETE" });
}

async function canvasBox(page) {
  return T(page, "overlay-canvas").boundingBox();
}
const pointIn = (box) => (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

async function dragTo(page, box, a, b, { shift = false, steps = 12 } = {}) {
  const at = pointIn(box);
  await page.mouse.move(...at(...a));
  await page.mouse.down();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(...at(...b), { steps });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

async function purple(page) {
  await T(page, "color-a855f7").click();
}

async function test(id, name, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, name, ok: true, ms: Date.now() - t0 });
    log(`  PASS ${id}  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ id, name, ok: false, err: e.message.split("\n")[0], ms: Date.now() - t0 });
    log(`  FAIL ${id}  ${name}\n        ${e.message.split("\n").slice(0, 3).join("\n        ")}`);
    if (process.env.DEBUG) log(`${e.stack}\n        cause: ${e.cause?.code ?? e.cause?.message}`);
  }
}

/** Runs `fn` with an app page and always closes it. */
async function withApp(opts, fn) {
  const app = await openApp(opts);
  try {
    await fn(app);
    consoleErrors.push(...app.errors);
  } finally {
    await app.ctx.close();
  }
}

// ----------------------------------------------------------------- scenarios

async function main() {
  await startServer();
  targetServer = await startTestApp(TARGET_PORT);
  browser = await chromium.launch({ channel: "msedge", headless: false, args: EDGE_ARGS });
  log(`\nAnnotRec 2.0 scenarios  (server ${BASE}, files in ${REC})\n`);

  log("API and server");
  await test("S01", "health reports FFmpeg and the proxy port", async () => {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    assert(h.ffmpeg === true, "ffmpeg missing");
    assert(h.proxyPort === PROXY, "wrong proxy port");
    assert(h.qualities.includes("high"), "qualities missing");
  });

  await test("S02", "address validation accepts good input and rejects bad", async () => {
    const post = (url) =>
      fetch(`${BASE}/api/target`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    for (const good of ["localhost:5055", "http://127.0.0.1:5055/x?y=1#z", "https://example.com", "  localhost:5055  "]) {
      const r = await post(good);
      assert(r.ok, `"${good}" should be accepted (${r.status})`);
    }
    for (const bad of ["", "   ", "ftp://x.com", "javascript:alert(1)", "http://", "file:///etc/passwd", "data:text/html,hi"]) {
      const r = await post(bad);
      assert(r.status === 400, `"${bad}" should be rejected (${r.status})`);
    }
    const ok = await (await post("localhost:5055/some/path?q=1#h")).json();
    assert(ok.viewportUrl === `http://localhost:${PROXY}/some/path?q=1#h`, `viewport url: ${ok.viewportUrl}`);
  });

  await test("S03", "host and origin guard blocks foreign callers", async () => {
    const call = (headers) =>
      new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.end();
      });
    assert((await call({})) === 200, "plain request should pass");
    assert((await call({ host: "evil.example.com" })) === 403, "foreign Host (DNS rebinding) should be blocked");
    assert((await call({ origin: "https://evil.example.com" })) === 403, "foreign Origin should be blocked");
    assert((await call({ origin: "http://localhost:5173" })) === 200, "a loopback Origin (dev server) should pass");
  });

  await test("S04", "file names cannot escape the recordings folder", async () => {
    for (const evil of ["..%2f..%2fserver%2findex.js", "..%5c..%5cpackage.json", "%2e%2e%2fpackage.json", "a.txt", "x.mp4%00.png"]) {
      const g = await fetch(`${BASE}/api/recordings/${evil}`);
      assert(g.status === 400 || g.status === 404, `GET ${evil} -> ${g.status}`);
      const d = await fetch(`${BASE}/api/recordings/${evil}`, { method: "DELETE" });
      assert(d.status === 400 || d.status === 204, `DELETE ${evil} -> ${d.status}`);
    }
    assert(fs.existsSync(path.join(ROOT, "package.json")), "package.json must still exist");
  });

  log("\nProxy");
  await test("S05", "proxy strips framing headers, fixes redirects, serves root-relative assets", async () => {
    await fetch(`${BASE}/api/target`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `localhost:${TARGET_PORT}` }) });
    const direct = await fetch(`http://localhost:${TARGET_PORT}/`);
    assert(direct.headers.get("x-frame-options") === "DENY", "the test app should refuse framing");
    const viaProxy = await fetch(`http://localhost:${PROXY}/`);
    assert(viaProxy.status === 200, `proxy status ${viaProxy.status}`);
    assert(!viaProxy.headers.get("x-frame-options"), "X-Frame-Options must be removed");
    const csp = viaProxy.headers.get("content-security-policy") ?? "";
    assert(!/frame-ancestors/i.test(csp), `frame-ancestors must be removed: ${csp}`);
    assert(/default-src/.test(csp), "other CSP directives must stay");
    const js = await fetch(`http://localhost:${PROXY}/app.js`);
    assert(js.status === 200 && (await js.text()).includes("script ok"), "root-relative asset must load through the proxy");
    const red = await fetch(`http://localhost:${PROXY}/redirect`, { redirect: "manual" });
    assert(red.status === 302, `redirect status ${red.status}`);
    const loc = red.headers.get("location") ?? "";
    assert(loc.includes(`:${PROXY}/`) && !loc.includes(`:${TARGET_PORT}`), `redirect must stay on the proxy: ${loc}`);
  });

  await test("S06", "proxy shows a friendly page when the target is down", async () => {
    await fetch(`${BASE}/api/target`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "localhost:5999" }) });
    const r = await fetch(`http://localhost:${PROXY}/`);
    assert(r.status === 502, `status ${r.status}`);
    const body = await r.text();
    assert(body.includes("Cannot reach the page") && body.includes("localhost:5999"), "error page text");
  });

  log("\nConversion");
  const webm = path.join(REC, "t.webm");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=801x601:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-c:v", "libvpx-vp9", "-c:a", "libopus", webm]);
  async function upload(file, query = "") {
    const res = await fetch(`${BASE}/api/recordings?${query}`, { method: "POST", body: fs.readFileSync(file) });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    return lines;
  }

  await test("S07", "upload converts to MP4 (even size, H.264+AAC) and streams progress", async () => {
    const lines = await upload(webm, "quality=standard&durationMs=4000");
    const done = lines.find((l) => l.done)?.done;
    assert(done, `no result: ${JSON.stringify(lines)}`);
    assert(lines.some((l) => l.progress !== undefined), "no progress lines");
    const p = probe(path.join(REC, done.name));
    assert(p.video.codec_name === "h264" && p.audio.codec_name === "aac", "codecs");
    assert(p.video.width % 2 === 0 && p.video.height % 2 === 0, `odd size ${p.video.width}x${p.video.height}`);
    near(p.vd, 4, 0.3, "video duration");
    near(p.ad, 4, 0.3, "audio duration");
    assert(done.durationMs > 3500, `reported duration ${done.durationMs}`);
  });

  await test("S08", "high quality works and an empty upload fails cleanly", async () => {
    const hi = (await upload(webm, "quality=high")).find((l) => l.done);
    assert(hi, "high quality failed");
    const empty = await fetch(`${BASE}/api/recordings`, { method: "POST", body: new Uint8Array(0) });
    const last = (await empty.text()).trim().split("\n").map((l) => JSON.parse(l)).pop();
    assert(last.error, `empty upload should error: ${JSON.stringify(last)}`);
    const junk = await fetch(`${BASE}/api/recordings`, { method: "POST", body: new TextEncoder().encode("not a video at all") });
    const jl = (await junk.text()).trim().split("\n").map((l) => JSON.parse(l)).pop();
    assert(jl.error, "garbage upload should error");
    const left = fs.readdirSync(REC).filter((n) => n.endsWith(".tmp") || n.endsWith(".part"));
    assert(left.length === 0, `leftover temp files: ${left}`);
  });

  await test("S09", "video is served with range requests; delete removes the sidecar", async () => {
    const files = await (await fetch(`${BASE}/api/recordings`)).json();
    const mp4 = files.find((f) => f.name.endsWith(".mp4"));
    const r = await fetch(`${BASE}/api/recordings/${mp4.name}`, { headers: { range: "bytes=0-99" } });
    assert(r.status === 206, `range status ${r.status}`);
    assert(files.find((f) => f.name === mp4.name).durationMs > 0, "duration metadata missing");
    const del = await fetch(`${BASE}/api/recordings/${mp4.name}`, { method: "DELETE" });
    assert(del.status === 204, "delete");
    assert(!fs.existsSync(path.join(REC, `${mp4.name}.json`)), "sidecar must go too");
  });

  await test("S10", "cancelling an upload mid-conversion leaves no files behind", async () => {
    const big = path.join(REC, "big.webm");
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "20", "-c:v", "libvpx", "-b:v", "6M", "-deadline", "realtime", big]);
    const before = new Set(fs.readdirSync(REC));
    // A fresh raw connection (a pooled one may have been closed by the server's keep-alive timeout).
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/api/recordings?durationMs=20000", method: "POST", agent: false },
        (res) => {
          res.once("data", () => {
            // First progress line arrived: FFmpeg is running. Hang up.
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", (e) => (e.code === "ECONNRESET" ? resolve() : reject(e)));
      req.end(fs.readFileSync(big));
    });
    await sleep(2500);
    const added = fs.readdirSync(REC).filter((n) => !before.has(n));
    assert(added.length === 0, `files left behind: ${added.join(", ")}`);
  });

  log("\nLive conversion");
  const liveJson = (urlPath, init) => fetch(`${BASE}${urlPath}`, init);

  await test("S11", "live session: chunks in, MP4 out; partial file is never listed", async () => {
    const { id } = await (await liveJson("/api/live?quality=standard", { method: "POST" })).json();
    assert(id && id.startsWith("recording-"), `session id ${id}`);
    const data = fs.readFileSync(webm);
    const cuts = [0, Math.floor(data.length / 3), Math.floor((2 * data.length) / 3), data.length];
    for (let i = 0; i < 3; i++) {
      const r = await liveJson(`/api/live/${id}/chunk`, { method: "POST", body: data.subarray(cuts[i], cuts[i + 1]) });
      assert(r.status === 204, `chunk ${i} -> ${r.status}`);
      const listed = (await (await fetch(`${BASE}/api/recordings`)).json()).map((f) => f.name);
      assert(!listed.some((n) => n.includes(id)), `partial recording must not be listed: ${listed}`);
    }
    const res = await liveJson(`/api/live/${id}/finish?durationMs=4000`, { method: "POST" });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const done = lines.find((l) => l.done)?.done;
    assert(done, `no result: ${JSON.stringify(lines)}`);
    const p = probe(path.join(REC, done.name));
    assert(p.video.codec_name === "h264" && p.audio.codec_name === "aac", "codecs");
    near(p.vd, 4, 0.3, "video duration");
    near(p.ad, 4, 0.3, "audio duration");
    assert(!fs.existsSync(path.join(REC, `${done.name}.part`)), "the .part file must be renamed away");
    assert((await liveJson(`/api/live/${id}/finish`, { method: "POST" })).status === 404, "a finished session is gone");
  });

  await test("S12", "live session errors: unknown id, abort, and a corrupt stream clean up", async () => {
    assert((await liveJson("/api/live/nope/chunk", { method: "POST", body: "x" })).status === 404, "unknown session");
    const before = new Set(fs.readdirSync(REC));
    const { id } = await (await liveJson("/api/live", { method: "POST" })).json();
    await liveJson(`/api/live/${id}/chunk`, { method: "POST", body: fs.readFileSync(webm).subarray(0, 20000) });
    assert((await liveJson(`/api/live/${id}`, { method: "DELETE" })).status === 204, "abort");
    await sleep(600);
    // A stream that is not a video at all: finish must report an error, not hang or save junk.
    const bad = await (await liveJson("/api/live", { method: "POST" })).json();
    await liveJson(`/api/live/${bad.id}/chunk`, { method: "POST", body: "this is not a webm file" });
    const res = await liveJson(`/api/live/${bad.id}/finish`, { method: "POST" });
    const last = (await res.text()).trim().split("\n").map((l) => JSON.parse(l)).pop();
    assert(last.error, `a corrupt stream should end in an error: ${JSON.stringify(last)}`);
    await sleep(600);
    const added = fs.readdirSync(REC).filter((n) => !before.has(n));
    assert(added.length === 0, `files left behind: ${added.join(", ")}`);
  });

  log("\nBrowser UI");
  await test("U01", "an unsupported browser gets a clear message and disabled controls", async () => {
    await withApp({ init: "delete window.CropTarget;" }, async ({ page }) => {
      await T(page, "unsupported").waitFor();
      assert(await T(page, "start").isDisabled(), "Start should be disabled");
      assert(await T(page, "tool-pen").isDisabled(), "tools should be disabled");
    });
  });

  await test("U02", "first load: ready, sample page, getting-started, sane defaults", async () => {
    await clearFiles();
    await withApp({ settings: null }, async ({ page, frame }) => {
      assert((await T(page, "phase").innerText()) === "READY", "READY");
      await T(page, "getting-started").waitFor();
      assert((await frame.locator("#n").innerText()) === "0", "sample counter");
      assert(await T(page, "clear").isDisabled(), "Clear all disabled while live");
      assert(await T(page, "undo").isDisabled(), "Undo disabled with no ink");
      await T(page, "open-settings").click();
      assert((await T(page, "setting-countdown").inputValue()) === "3", "countdown default 3s");
    });
  });

  await test("U03", "a page that refuses framing loads, address persists, bad address is reported", async () => {
    await withApp({}, async ({ page }) => {
      await T(page, "address").fill(`localhost:${TARGET_PORT}`);
      await T(page, "go").click();
      const frame = page.frameLocator("iframe");
      await frame.getByText("TEST TARGET").waitFor();
      await frame.getByText("script ok").waitFor();
      await frame.locator("#r").click(); // redirect inside the proxied page
      await frame.getByText("PAGE TWO").waitFor();
      await T(page, "address").fill("ftp://nope");
      await T(page, "go").click();
      await T(page, "toast-error").waitFor();
      await page.reload();
      assert((await T(page, "address").inputValue()) === `localhost:${TARGET_PORT}`, "last good address should be restored");
    });
  });

  await test("U04", "viewport presets, size chip, and locking while recording", async () => {
    await withApp({ width: 1700, height: 950 }, async ({ page }) => {
      await T(page, "size-preset").selectOption("1280");
      await sleep(300);
      const chip = await T(page, "size-chip").innerText();
      assert(/1280\s*×\s*720/.test(chip), `chip: ${chip}`);
      await T(page, "size-preset").selectOption("mobile");
      await sleep(300);
      assert(/390\s*×\s*844|390\s*×\s*\d+/.test(await T(page, "size-chip").innerText()), "mobile size");
      await T(page, "size-preset").selectOption("fit");
      await startRec(page);
      assert(await T(page, "size-preset").isDisabled(), "size locked while recording");
      await sleep(800);
      await stopRec(page);
      assert(!(await T(page, "size-preset").isDisabled()), "size unlocked after");
      assert((await T(page, "size-preset").inputValue()) === "fit", "back to Fit after a recording");
    });
  });

  await test("U05", "full scenario: MP4 shows live page, frozen ink, and live page again, with matching audio", async () => {
    await withApp({}, async ({ page, frame }) => {
      await startRec(page);
      await sleep(2500); // t ~ 0..2.5 live
      await frame.getByText("Click me").click();
      await T(page, "tool-rect").click();
      await T(page, "frozen-badge").waitFor();
      assert((await phase(page, "RECORDING").count()) === 1, "still recording while frozen");
      const box = await canvasBox(page);
      await purple(page);
      await dragTo(page, box, [0.1, 0.15], [0.5, 0.5]);
      await T(page, "tool-arrow").click();
      await dragTo(page, box, [0.6, 0.7], [0.85, 0.4]);
      await T(page, "tool-text").click();
      await page.mouse.click(...pointIn(box)(0.12, 0.6));
      await page.keyboard.type("REMOVE THIS");
      await page.keyboard.press("Enter");
      await sleep(3000); // ink on screen for ~3s+
      assert((await frame.locator("#n").innerText()) === "1", "frozen page ignored input");
      await T(page, "clear").click();
      await sleep(2500); // live again
      await frame.getByText("Click me").click();
      assert((await frame.locator("#n").innerText()) === "2", "live again after Clear all");
      await sleep(500);
      await stopRec(page);

      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      near(p.vd, p.ad, 0.4, "audio vs video duration");
      assert(p.video.codec_name === "h264" && p.audio.codec_name === "aac", "codecs");
      const early = ink(frameAt(f.path, 1.2));
      const mid = ink(frameAt(f.path, p.vd - 3.8));
      const late = ink(frameAt(f.path, p.vd - 0.8));
      assert(early.n < 30, `no ink expected at the start, found ${early.n}`);
      assert(mid.n > 800, `ink expected while frozen, found ${mid.n} px`);
      assert(late.n < 30, `no ink expected after Clear all, found ${late.n}`);
    });
  });

  await test("U06", "video is exactly the viewport: no toolbar, no top bar", async () => {
    await withApp({ width: 1480, height: 820 }, async ({ page }) => {
      const m = await T(page, "viewport").boundingBox();
      await startRec(page);
      await sleep(1500);
      await stopRec(page);
      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      near(p.video.width, m.width, 3, "video width = viewport width (1:1, no scaling)");
      near(p.video.height, m.height, 3, "video height = viewport height (1:1, no scaling)");
      const fr = frameAt(f.path, 0.8);
      assert(colorShare(fr, [18, 21, 28], 6) < 0.01, "the dark app chrome must not appear in the video");
    });
  });

  await test("U07", "ink lands where it was drawn at 1.5x display scaling", async () => {
    await withApp({ dpr: 1.5, width: 1300, height: 760 }, async ({ page }) => {
      await startRec(page);
      await sleep(1000);
      await T(page, "tool-rect").click();
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      const box = await canvasBox(page);
      await dragTo(page, box, [0.25, 0.3], [0.7, 0.8]);
      await sleep(2500);
      await stopRec(page);
      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      const i = ink(frameAt(f.path, p.vd - 1.2));
      assert(i.n > 400, `ink pixels ${i.n}`);
      const tol = 0.035;
      near(i.minX / i.w, 0.25, tol, "left edge");
      near(i.minY / i.h, 0.3, tol, "top edge");
      near(i.maxX / i.w, 0.7, tol, "right edge");
      near(i.maxY / i.h, 0.8, tol, "bottom edge");
    });
  });

  await test("U08", "pause removes the paused time; timer stops while paused", async () => {
    await withApp({}, async ({ page }) => {
      await startRec(page);
      await sleep(3000);
      await T(page, "pause").click();
      await phase(page, "PAUSED").waitFor();
      const t1 = await T(page, "timer").innerText();
      await sleep(4000);
      const t2 = await T(page, "timer").innerText();
      assert(t1 === t2, `timer moved while paused: ${t1} -> ${t2}`);
      await T(page, "resume").click();
      await phase(page, "RECORDING").waitFor();
      await sleep(3000);
      await stopRec(page);
      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      near(p.vd, 6, 1.0, "video duration should exclude the 4 s pause");
      near(p.ad, p.vd, 0.4, "audio matches video");
    });
  });

  await test("U09", "keyboard shortcuts drive the whole flow", async () => {
    await withApp({}, async ({ page, frame }) => {
      await page.mouse.click(5, 5); // focus the page, not the iframe
      await page.keyboard.press("?");
      await T(page, "modal").waitFor();
      await page.keyboard.press("Escape");
      await T(page, "modal").waitFor({ state: "detached" });
      await page.keyboard.press("r");
      await phase(page, "RECORDING").waitFor({ timeout: 20000 });
      await page.keyboard.press("b");
      await T(page, "frozen-badge").waitFor();
      const box = await canvasBox(page);
      await dragTo(page, box, [0.2, 0.2], [0.6, 0.5]);
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 1, "one shape drawn");
      await page.keyboard.press("Control+z");
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 0, "undo by Ctrl+Z");
      await page.keyboard.press("Control+y");
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 1, "redo by Ctrl+Y");
      await page.keyboard.press(" ");
      await phase(page, "PAUSED").waitFor();
      await page.keyboard.press(" ");
      await phase(page, "RECORDING").waitFor();
      await page.keyboard.press("Shift+m");
      await T(page, "mic-label").filter({ hasText: "Mic off" }).waitFor();
      await page.keyboard.press("Shift+m");
      await page.keyboard.press("Escape");
      await T(page, "frozen-badge").waitFor({ state: "detached" });
      await frame.getByText("Click me").click();
      await page.mouse.click(5, 5);
      await page.keyboard.press("Shift+r");
      await phase(page, "READY").waitFor({ timeout: 90000 });
      await latest(page, ".mp4");
    });
  });

  await test("U10", "annotating before recording freezes the page; screenshot contains the ink", async () => {
    await withApp({}, async ({ page, frame }) => {
      await T(page, "tool-ellipse").click();
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      await dragTo(page, await canvasBox(page), [0.2, 0.2], [0.6, 0.6]);
      await T(page, "screenshot").click();
      await T(page, "toast-success").waitFor();
      const shot = await latest(page, ".png");
      const i = ink(frameAt(shot.path, 0));
      assert(i.n > 300, `screenshot ink ${i.n}`);
      await T(page, "clear").click();
      await frame.getByText("Click me").click();
      assert((await frame.locator("#n").innerText()) === "1", "page live after Clear all");
    });
  });

  await test("U11", "select, move and delete shapes; undo restores", async () => {
    await withApp({}, async ({ page }) => {
      await T(page, "tool-rect").click();
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      const box = await canvasBox(page);
      const at = pointIn(box);
      await dragTo(page, box, [0.2, 0.3], [0.45, 0.6]);
      const before = ink(await shotFrame(page));
      await T(page, "tool-select").click();
      await page.mouse.click(...at(0.2, 0.45)); // on the left edge
      await dragTo(page, box, [0.2, 0.45], [0.5, 0.45], { steps: 8 });
      const after = ink(await shotFrame(page));
      assert(after.minX - before.minX > box.width * 0.2, `shape should have moved right (${before.minX} -> ${after.minX})`);
      await T(page, "undo").click();
      const undone = ink(await shotFrame(page));
      near(undone.minX, before.minX, 4, "undo restores the position");
      await page.mouse.click(...at(0.2, 0.45));
      await T(page, "delete").click();
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 0, "deleted");
    });
  });

  await test("U12", "Shift constrains lines to straight and rectangles to squares", async () => {
    await withApp({}, async ({ page }) => {
      await T(page, "tool-line").click();
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      const box = await canvasBox(page);
      await dragTo(page, box, [0.2, 0.3], [0.6, 0.33], { shift: true });
      const line = ink(await shotFrame(page));
      assert(line.maxY - line.minY < 14, `line should be horizontal (height ${line.maxY - line.minY})`);
      await T(page, "tool-rect").click();
      await dragTo(page, box, [0.1, 0.5], [0.4, 0.58], { shift: true });
      await T(page, "tool-eraser").click();
      await page.mouse.click(...pointIn(box)(0.4, 0.31)); // erase the line
      const sq = ink(await shotFrame(page));
      near(sq.maxX - sq.minX, sq.maxY - sq.minY, 10, "rectangle should be a square");
    });
  });

  await test("U13", "numbered markers count up; eraser removes one", async () => {
    await withApp({}, async ({ page }) => {
      await T(page, "tool-marker").click();
      await T(page, "frozen-badge").waitFor();
      const box = await canvasBox(page);
      const at = pointIn(box);
      for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.6, 0.2]]) await page.mouse.click(...at(x, y));
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 3, "three markers");
      await T(page, "tool-eraser").click();
      await page.mouse.click(...at(0.4, 0.2));
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 2, "one erased");
    });
  });

  await test("U14", "microphone: level meter sees sound, muting silences it, toggle label follows", async () => {
    await withApp({}, async ({ page }) => {
      await startRec(page);
      let max = 0;
      for (let i = 0; i < 40; i++) {
        max = Math.max(max, await page.evaluate(() => window.__annotrec.micLevel()));
        await sleep(100);
      }
      assert(max > 0.05, `mic level never rose (max ${max})`);
      await T(page, "mic").click();
      await T(page, "mic-label").filter({ hasText: "Mic off" }).waitFor();
      await sleep(400);
      let muted = 0;
      for (let i = 0; i < 20; i++) {
        muted = Math.max(muted, await page.evaluate(() => window.__annotrec.micLevel()));
        await sleep(50);
      }
      assert(muted < 0.02, `muted mic still loud (${muted})`);
      await T(page, "mic").click();
      await stopRec(page);
    });
  });

  await test("U15", "no microphone permission: recording continues, video only, user is told", async () => {
    await withApp(
      { init: `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));` },
      async ({ page }) => {
        await startRec(page);
        await T(page, "toast-info").waitFor();
        await sleep(1500);
        await stopRec(page);
        const f = await latest(page, ".mp4");
        const p = probe(f.path);
        assert(p.video && !p.audio, "expected video without an audio track");
      },
    );
  });

  await test("U16", "cancelling the share prompt leaves the app usable", async () => {
    await withApp(
      { init: `navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException("cancel", "NotAllowedError"));` },
      async ({ page }) => {
        await T(page, "start").click();
        await T(page, "toast-error").filter({ hasText: "cancelled" }).waitFor();
        assert((await T(page, "phase").innerText()) === "READY", "back to READY");
        assert(!(await T(page, "start").isDisabled()), "Start still available");
        await T(page, "tool-pen").click();
        await T(page, "toast-error").first().waitFor();
        assert((await T(page, "frozen-badge").count()) === 0, "must not freeze without capture");
      },
    );
  });

  await test("U17", "'Stop sharing' in the browser bar saves the recording so far", async () => {
    await withApp({}, async ({ page }) => {
      await startRec(page);
      await T(page, "tool-pen").click();
      await T(page, "frozen-badge").waitFor();
      await sleep(2000);
      await page.evaluate(() => window.__annotrec.endSession());
      await phase(page, "READY").waitFor({ timeout: 90000 });
      await T(page, "frozen-badge").waitFor({ state: "detached" });
      const f = await latest(page, ".mp4");
      near(probe(f.path).vd, 3, 1.5, "saved length");
      assert((await T(page, "share-hint").innerText()).includes("first time"), "sharing state reset");
    });
  });

  await test("U18", "closing the tab mid-recording asks for confirmation", async () => {
    const { ctx, page } = await openApp();
    try {
      await startRec(page);
      let sawDialog = false;
      page.on("dialog", async (d) => {
        sawDialog = d.type() === "beforeunload";
        await d.dismiss();
      });
      await page.close({ runBeforeUnload: true });
      await sleep(500);
      assert(sawDialog, "no beforeunload dialog");
    } finally {
      await ctx.close();
    }
  });

  await test("U19", "Esc cancels the countdown: nothing recorded, layout restored", async () => {
    await withApp({ settings: { countdown: 5 } }, async ({ page }) => {
      const before = (await (await page.request.get(`${BASE}/api/recordings`)).json()).length;
      await page.mouse.click(5, 5);
      await T(page, "start").click();
      await T(page, "countdown").waitFor();
      await sleep(1200);
      await page.keyboard.press("Escape");
      await T(page, "countdown").waitFor({ state: "detached", timeout: 4000 });
      assert((await T(page, "phase").innerText()) === "READY", "READY after cancel");
      assert((await T(page, "size-preset").inputValue()) === "fit", "size restored");
      await sleep(800);
      const after = (await (await page.request.get(`${BASE}/api/recordings`)).json()).length;
      assert(after === before, "a cancelled countdown must not save anything");
    });
  });

  await test("U20", "settings persist across reloads and change behaviour", async () => {
    await withApp({ settings: null }, async ({ page }) => {
      await T(page, "open-settings").click();
      await T(page, "setting-countdown").selectOption("0");
      await T(page, "setting-quality").selectOption("high");
      await T(page, "modal-close").click();
      await T(page, "color-3b82f6").click();
      await page.reload();
      await T(page, "open-settings").click();
      assert((await T(page, "setting-countdown").inputValue()) === "0", "countdown persisted");
      assert((await T(page, "setting-quality").inputValue()) === "high", "quality persisted");
      await page.keyboard.press("Escape");
      await startRec(page); // countdown off: no wait
      await sleep(800);
      await stopRec(page);
    });
  });

  await test("U21", "two recordings in one session; library plays, downloads, confirms before delete", async () => {
    await clearFiles();
    await withApp({}, async ({ page }) => {
      await startRec(page);
      await sleep(1500);
      await stopRec(page);
      await startRec(page);
      await sleep(1500);
      await stopRec(page);
      const rows = T(page, "file");
      assert((await rows.count()) === 2, `expected 2 files, got ${await rows.count()}`);
      await rows.first().getByRole("button", { name: /Open/ }).first().click();
      const video = T(page, "player-video");
      await video.waitFor();
      await page.waitForFunction(() => {
        const v = document.querySelector("video");
        return v && v.readyState >= 2 && v.duration > 0;
      });
      assert((await page.locator("a:has-text('Download')").first().getAttribute("href")).includes("download=1"), "download link");
      await page.keyboard.press("Escape");
      await T(page, "modal").waitFor({ state: "detached" });
      await rows.first().getByTestId("delete-file").click();
      assert((await rows.count()) === 2, "first click must only ask");
      await T(page, "confirm-delete").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=file]").length === 1);
    });
  });

  await test("U22", "a page that blocks framing is recorded (proxied content is in the MP4)", async () => {
    await withApp({}, async ({ page }) => {
      await T(page, "address").fill(`localhost:${TARGET_PORT}`);
      await T(page, "go").click();
      await page.frameLocator("iframe").getByText("script ok").waitFor();
      await startRec(page);
      await sleep(2000);
      await stopRec(page);
      const f = await latest(page, ".mp4");
      const share = colorShare(frameAt(f.path, 1.0), [0, 170, 85], 30);
      assert(share > 0.6, `the test app's green should fill the video (${(share * 100).toFixed(0)}%)`);
    });
  });

  await test("U23", "resizing the browser window mid-recording still yields a valid MP4", async () => {
    await withApp({}, async ({ page }) => {
      await startRec(page);
      await sleep(1500);
      await page.setViewportSize({ width: 1200, height: 700 });
      await sleep(1500);
      await T(page, "tool-pen").click();
      await sleep(800);
      await stopRec(page);
      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      assert(p.video.width > 0 && p.vd > 2, `valid video: ${JSON.stringify({ w: p.video.width, h: p.video.height, vd: p.vd, ad: p.ad })}`);
    });
  });

  await test("U24", "every control has an accessible name; no console errors", async () => {
    await withApp({}, async ({ page, errors }) => {
      const nameless = await page.evaluate(() =>
        [...document.querySelectorAll("button, a, input, select")]
          .filter((el) => {
            const t = (el.textContent || "").trim();
            return !t && !el.getAttribute("aria-label") && !el.getAttribute("title") && !el.id && el.type !== "hidden";
          })
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      assert(nameless.length === 0, `unnamed controls: ${nameless.join(" | ")}`);
      assert(errors.length === 0, `console errors: ${errors.join(" | ")}`);
    });
  });

  await test("U25", "live conversion: a 20 s recording is ready within ~2 s of pressing Stop", async () => {
    await withApp({}, async ({ page }) => {
      await startRec(page);
      const recordedFrom = Date.now(); // wall clock, so a slow machine does not break the length check
      await T(page, "tool-pen").click();
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      const box = await canvasBox(page);
      for (let i = 0; i < 6; i++) {
        await dragTo(page, box, [0.1 + i * 0.1, 0.2], [0.2 + i * 0.1, 0.6]);
        await sleep(3000);
      }
      await T(page, "clear").click();
      await sleep(1500);
      const t0 = Date.now();
      const wallSeconds = (t0 - recordedFrom) / 1000;
      await T(page, "stop").click();
      await phase(page, "READY").waitFor({ timeout: 90000 });
      const stopMs = Date.now() - t0;
      const f = await latest(page, ".mp4");
      const p = probe(f.path);
      near(p.vd, wallSeconds, 2.5, "duration vs the time actually recorded");
      near(p.ad, p.vd, 0.4, "audio vs video");
      assert(ink(frameAt(f.path, Math.min(9, p.vd / 2))).n > 300, "ink present mid-recording");
      assert(stopMs < 2600, `Stop to ready took ${stopMs} ms: live conversion should make it quick`);
      log(`        (Stop to ready: ${stopMs} ms for a ${p.vd.toFixed(1)} s recording)`);
    });
  });

  await test("U26", "if live uploads fail, the whole recording is still saved at Stop", async () => {
    await withApp(
      { init: `const f = window.fetch; window.fetch = (u, o) => String(u).includes("/chunk") ? Promise.reject(new TypeError("network down")) : f(u, o);` },
      async ({ page }) => {
        await startRec(page);
        await sleep(3000);
        await stopRec(page);
        const f = await latest(page, ".mp4");
        const p = probe(f.path);
        near(p.vd, 3, 1, "duration");
        assert(p.audio, "audio present");
        const left = fs.readdirSync(REC).filter((n) => n.endsWith(".part"));
        assert(left.length === 0, `leftover partial files: ${left}`);
      },
    );
  });

  log("\nExtensibility (the architecture's promises)");

  await test("S13", "server ports: a custom converter and storage replace FFmpeg and the file layout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-port-"));
    const committed = [];
    class SpyStorage extends FileStorage {
      commit(name, meta) {
        committed.push(name);
        return super.commit(name, meta);
      }
    }
    // A converter that does no encoding at all: it just keeps the bytes.
    const fake = {
      qualities: ["only"],
      available: async () => true,
      start(input, output) {
        if (input) {
          fs.copyFileSync(input, output);
          return { stdin: null, promise: Promise.resolve(777), kill() {} };
        }
        const stdin = new PassThrough();
        const out = fs.createWriteStream(output);
        stdin.pipe(out);
        return { stdin, promise: new Promise((r) => out.on("close", () => r(1234))), kill: () => stdin.destroy() };
      },
    };
    const seen = [];
    const ar = createAnnotRec({
      storage: new SpyStorage(dir),
      converter: fake,
      proxyPort: 4130,
      plugins: [(ctx) => ctx.events.on("recording:saved", (f) => seen.push(f.name))],
    });
    const app = express();
    app.use(ar.router);
    const server = await new Promise((r) => {
      const s = app.listen(4131, "127.0.0.1", () => r(s));
    });
    const U = "http://localhost:4131";
    const lines = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    try {
      const health = await (await fetch(`${U}/api/health`)).json();
      assert(health.qualities.join() === "only", `qualities come from the converter: ${health.qualities}`);
      const { id } = await (await fetch(`${U}/api/live`, { method: "POST" })).json();
      for (const part of ["AAAA", "BBBB", "CCCC"]) {
        const r = await fetch(`${U}/api/live/${id}/chunk`, { method: "POST", body: part });
        assert(r.status === 204, `chunk -> ${r.status}`);
      }
      const done = (await lines(await fetch(`${U}/api/live/${id}/finish`, { method: "POST" }))).find((l) => l.done)?.done;
      assert(done, "live finish returned no file");
      assert(done.durationMs === 1234, "the converter's duration is used");
      assert(fs.readFileSync(path.join(dir, done.name), "utf8") === "AAAABBBBCCCC", "the stored file is what the converter wrote");
      assert(committed.includes(done.name), "the custom storage committed the file");
      assert(seen.includes(done.name), "the server plugin heard recording:saved");
      const whole = (await lines(await fetch(`${U}/api/recordings`, { method: "POST", body: "WHOLE" }))).find((l) => l.done)?.done;
      assert(whole && whole.durationMs === 777, "the whole-file path uses the converter too");
      assert(fs.readFileSync(path.join(dir, whole.name), "utf8") === "WHOLE", "whole-file content");
    } finally {
      server.close();
      await ar.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("P01", "mounted at /tools/annotrec inside another Express app: app, API, proxy and recordings work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-mount-"));
    const saved = [];
    const ar = createAnnotRec({
      recDir: dir,
      proxyPort: 4121,
      plugins: [
        (ctx) => {
          ctx.events.on("recording:saved", (f) => saved.push(f.name));
          ctx.router.get("/api/ping", (_q, res) => res.json({ pong: true }));
        },
      ],
    });
    const host = express();
    host.get("/", (_q, res) => res.send("host app root"));
    host.use("/tools/annotrec", ar.router);
    host.use("/tools/annotrec", express.static(path.join(ROOT, "client", "dist")));
    const server = await new Promise((r) => {
      const s = host.listen(4120, "127.0.0.1", () => r(s));
    });
    await ar.startProxy();
    try {
      assert((await (await fetch("http://localhost:4120/tools/annotrec/api/ping")).json()).pong, "a server plugin can add a route");
      assert((await fetch("http://localhost:4120/api/health")).status === 404, "the router must not leak outside its mount path");
      assert((await (await fetch("http://localhost:4120/")).text()) === "host app root", "the host app is untouched");
      await withApp({ url: "http://localhost:4120/tools/annotrec/" }, async ({ page }) => {
        await startRec(page);
        await T(page, "tool-pen").click();
        await T(page, "frozen-badge").waitFor();
        await sleep(1500);
        await T(page, "clear").click();
        await stopRec(page);
        await T(page, "file").first().waitFor();
      });
      assert(saved.length === 1, `the server plugin should have seen one saved recording, saw ${saved.length}`);
      const mp4 = fs.readdirSync(dir).find((n) => n.endsWith(".mp4"));
      assert(mp4, "the MP4 is in the mounted instance's folder");
      assert(probe(path.join(dir, mp4)).video.codec_name === "h264", "valid MP4");
    } finally {
      server.close();
      await ar.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const HOST = `${BASE}/host.html`;

  await test("P02", "a plugin adds a tool, shape, command, shortcut, panel, button and event reaction without touching the core", async () => {
    await withApp({ url: HOST }, async ({ page }) => {
      await T(page, "notes-card").waitFor();
      await T(page, "note-button").waitFor();
      await T(page, "tool-stamp").waitFor();
      const lineCount = () => T(page, "notes-lines").locator("li").count();
      const n0 = await lineCount();
      // the tool got its shortcut ("k") automatically
      await page.mouse.click(5, 5);
      await page.keyboard.press("k");
      await T(page, "frozen-badge").waitFor();
      await purple(page);
      const box = await canvasBox(page);
      await page.mouse.click(...pointIn(box)(0.3, 0.4));
      assert(Number(await T(page, "tools").getAttribute("data-ink")) === 1, "the new shape was added");
      const px = ink(await shotFrame(page));
      assert(px.n > 100, `the new shape was painted by its own renderer (${px.n} px)`);
      await page.keyboard.press("Escape");
      // a command, by shortcut and by the plugin's own button
      await page.keyboard.press("Control+Shift+N");
      await T(page, "note-button").click();
      assert((await lineCount()) === n0 + 2, "the command ran twice");
      // reacting to a core event
      await page.keyboard.press("s");
      await T(page, "toast-success").waitFor();
      await page.waitForFunction((n) => document.querySelectorAll("[data-testid=notes-lines] li").length === n, n0 + 3);
      // its own state survives a reload (settings namespace)
      await page.reload();
      await T(page, "notes-lines").waitFor();
      assert((await lineCount()) >= n0 + 3, "the plugin's saved state came back");
    });
  });

  await test("P03", "a custom recording sink: recordings are downloaded in the browser, no server involved", async () => {
    await withApp({ url: HOST }, async ({ page }) => {
      const before = (await (await page.request.get(`${BASE}/api/recordings`)).json()).filter((f) => f.name.endsWith(".mp4")).length;
      await T(page, "open-settings").click();
      await T(page, "setting-sink").selectOption("download");
      await T(page, "modal-close").click();
      await startRec(page);
      await sleep(2500);
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), T(page, "stop").click()]);
      assert(download.suggestedFilename().endsWith(".webm"), `downloaded ${download.suggestedFilename()}`);
      const out = path.join(REC, "downloaded.webm");
      await download.saveAs(out);
      const p = probe(out);
      assert(p.video && p.audio, "the downloaded recording has picture and sound");
      await phase(page, "READY").waitFor({ timeout: 30000 });
      await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=notes-lines] li")].some((li) => li.textContent.includes(".webm")));
      const after = (await (await page.request.get(`${BASE}/api/recordings`)).json()).filter((f) => f.name.endsWith(".mp4")).length;
      assert(after === before, "nothing was sent to the server");
    });
  });

  await test("P04", "built-in features can be left out", async () => {
    await withApp({ url: `${HOST}?exclude=screenshot` }, async ({ page }) => {
      await T(page, "start").waitFor();
      assert((await T(page, "screenshot").count()) === 0, "no screenshot button");
      await page.mouse.click(5, 5);
      await page.keyboard.press("s");
      await sleep(600);
      assert((await T(page, "toast-success").count()) === 0 && (await T(page, "toast-error").count()) === 0, "the shortcut is gone too");
      assert((await T(page, "tool-pen").count()) === 1, "the other features are unaffected");
    });
  });

  await test("P05", "a plugin that crashes, at start-up or while rendering, does not take the app down", async () => {
    await withApp({ url: HOST }, async ({ page, errors }) => {
      await page.evaluate(() => {
        const k = window.__annotrec.kernel;
        k.use({ id: "bad-startup", setup() { throw new Error("boom at startup"); } });
        k.panels.add({ id: "bad-panel", slot: "sidebar", order: 99, component: () => { throw new Error("boom while rendering"); } });
      });
      await T(page, "toast-error").filter({ hasText: "bad-startup" }).waitFor();
      await sleep(400);
      assert(await T(page, "start").isVisible(), "the rest of the app still renders");
      assert((await T(page, "phase").innerText()) === "READY", "and still works");
      await T(page, "tool-pen").click();
      await T(page, "frozen-badge").waitFor();
      errors.length = 0; // the crashes above are the point of this test
    });
  });

  await test("P06", "the whole app can be driven through commands, with no clicks", async () => {
    await withApp({ url: HOST }, async ({ page, errors }) => {
      const run = (id, args) => page.evaluate(([i, a]) => window.__annotrec.kernel.run(i, a), [id, args]);
      await run("recording.start");
      await phase(page, "RECORDING").waitFor({ timeout: 20000 });
      await run("annotation.pickTool", { id: "rect" });
      await T(page, "frozen-badge").waitFor();
      await run("recording.togglePause");
      await phase(page, "PAUSED").waitFor();
      await run("recording.togglePause");
      await phase(page, "RECORDING").waitFor();
      await run("annotation.goLive");
      await T(page, "frozen-badge").waitFor({ state: "detached" });
      await sleep(1200);
      await run("recording.stop");
      await phase(page, "READY").waitFor({ timeout: 60000 });
      await run("no.such.command");
      await T(page, "toast-error").filter({ hasText: "Unknown command" }).waitFor();
      errors.length = 0;
    });
  });

  if (LONG) {
    await test("L01", "a 60 s recording with continuous annotation stays in sync and does not leak memory", async () => {
      await withApp({}, async ({ page }) => {
        await startRec(page);
        const heap0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
        const t0 = Date.now();
        await T(page, "tool-pen").click();
        await T(page, "frozen-badge").waitFor();
        const box = await canvasBox(page);
        for (let i = 0; Date.now() - t0 < 60000; i++) {
          await dragTo(page, box, [0.1 + (i % 7) * 0.1, 0.2], [0.2 + (i % 7) * 0.1, 0.7], { steps: 20 });
          if (i % 5 === 4) {
            await T(page, "clear").click();
            await T(page, "tool-pen").click();
            await T(page, "frozen-badge").waitFor();
          }
        }
        const heap1 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
        await stopRec(page);
        const f = await latest(page, ".mp4");
        const p = probe(f.path);
        near(p.vd, 60, 2.5, "duration");
        near(p.ad, p.vd, 0.5, "audio vs video");
        assert(heap1 - heap0 < 60e6, `JS heap grew ${((heap1 - heap0) / 1e6).toFixed(0)} MB`);
      });
    });
  }
}

/** A screenshot of the viewport as raw pixels, taken by the page (not the recorder). */
async function shotFrame(page) {
  const png = path.join(REC, `px-${Date.now()}.png`);
  const box = await T(page, "viewport").boundingBox();
  await page.screenshot({ path: png, clip: box });
  return frameAt(png, 0);
}

try {
  await main();
} catch (e) {
  results.push({ id: "SETUP", name: "harness", ok: false, err: e.message });
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  serverProc?.kill();
  targetServer?.close();
}

const failed = results.filter((r) => !r.ok);
const unexpected = consoleErrors.filter((m) => !/NotAllowed|denied|cancel|Failed to load resource|502/i.test(m));
log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
if (unexpected.length) log(`Unexpected browser console errors (${unexpected.length}):\n  ${[...new Set(unexpected)].slice(0, 8).join("\n  ")}`);
fs.writeFileSync(path.join(ROOT, "scripts", "last-run.json"), JSON.stringify({ at: new Date().toISOString(), results, unexpected }, null, 2));
try {
  fs.rmSync(REC, { recursive: true, force: true });
} catch {
  /* temp folder; the OS cleans it */
}
process.exit(failed.length ? 1 : 0);
