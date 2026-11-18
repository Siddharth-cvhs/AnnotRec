// Which extension APIs exist in each installed browser? Loads a tiny test extension and asks its service worker.
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const L = process.env.LOCALAPPDATA;
const EXT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "probe-ext");
const browsers = {
  Edge: { channel: "msedge" },
  Chrome: { executablePath: `${L}\\Google\\Chrome\\Application\\chrome.exe` },
  Brave: { executablePath: `${L}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` },
  Opera: { executablePath: `${L}\\Programs\\Opera\\opera.exe` },
};

const ask = () => ({
  tabCapture: typeof chrome.tabCapture?.getMediaStreamId,
  offscreen: typeof chrome.offscreen?.createDocument,
  sidePanel: typeof chrome.sidePanel?.open,
  scripting: typeof chrome.scripting?.executeScript,
  commands: typeof chrome.commands?.onCommand,
  downloads: typeof chrome.downloads?.download,
  storage: typeof chrome.storage?.local?.get,
  captureVisibleTab: typeof chrome.tabs?.captureVisibleTab,
  userScripts: typeof chrome.userScripts,
});

for (const [name, opts] of Object.entries(browsers)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-prof-"));
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      headless: false,
      timeout: 30000,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      ...opts,
    });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    console.log(name.padEnd(7), JSON.stringify(await sw.evaluate(ask)));
  } catch (e) {
    console.log(name.padEnd(7), "extension did not load / could not be driven:", e.message.split("\n")[0]);
  } finally {
    await ctx?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
