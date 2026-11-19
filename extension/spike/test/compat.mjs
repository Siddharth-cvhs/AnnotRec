// Does this browser have everything the extension needs? Run it with BROWSER=edge | brave | chrome.
//   BROWSER=brave node test/compat.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER, launch, launchOptions, extensionWorker, rmQuiet } from "./browser.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch", "--window-size=1100,700", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  check(await sw.evaluate(() => chrome.runtime.id) === EXT_ID, "the extension gets its fixed id in this browser", EXT_ID);

  // APIs of the extension system, as seen by the service worker
  const api = await sw.evaluate(() => ({
    version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1],
    sidePanel: typeof chrome.sidePanel?.setPanelBehavior,
    offscreen: typeof chrome.offscreen?.createDocument,
    scripting: typeof chrome.scripting?.executeScript,
    commands: typeof chrome.commands?.onCommand?.addListener,
    action: typeof chrome.action?.setBadgeText,
    storage: typeof chrome.storage?.local?.get,
    tabs: typeof chrome.tabs?.captureVisibleTab,
  }));
  console.log(`  info  ${BROWSER}, Chromium ${api.version}`);
  for (const k of ["offscreen", "scripting", "commands", "action", "storage", "tabs"]) check(api[k] === "function", `chrome.${k} is available`);
  check(api.sidePanel === "function", "chrome.sidePanel is available (otherwise the controls open in a small window)", api.sidePanel);

  // Web APIs the recorder uses, as seen by a page of the extension (that is where the recorder lives)
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/offscreen.html`);
  const web = await page.evaluate(async () => ({
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
    trackProcessor: typeof MediaStreamTrackProcessor,
    videoFrame: typeof VideoFrame,
    recorder: typeof MediaRecorder,
    h264: MediaRecorder.isTypeSupported("video/webm;codecs=h264,opus"),
    vp9: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus"),
    captureStream: typeof HTMLCanvasElement.prototype.captureStream,
    requestFrame: typeof CanvasCaptureMediaStreamTrack !== "undefined" && typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame,
    popover: typeof HTMLElement.prototype.showPopover,
    offscreenCanvas: typeof OffscreenCanvas,
  }));
  check(web.getDisplayMedia === "function", "window capture (getDisplayMedia)");
  check(web.trackProcessor === "function" && web.videoFrame === "function", "frame access (MediaStreamTrackProcessor, VideoFrame)");
  check(web.recorder === "function" && web.captureStream === "function" && web.requestFrame === "function", "recording from a canvas (MediaRecorder, captureStream, requestFrame)");
  check(web.h264, "H.264 recording, so the server only repackages it (the fast path)", `vp9 fallback: ${web.vp9}`);
  check(web.popover === "function" && web.offscreenCanvas === "function", "popover (top layer) and OffscreenCanvas for the drawing layer");
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  for (const d of [profile, extDir]) rmQuiet(d);
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
}
