// Which browser the tests drive: BROWSER=edge (default) | brave | chrome
//   BROWSER=brave node test/e2e.mjs        BROWSER=brave node test/all.mjs
import fs from "node:fs";

export const BROWSER = (process.env.BROWSER || "edge").toLowerCase();

const LOCAL = process.env.LOCALAPPDATA ?? "";
const PROGRAMS = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
const EXE = {
  brave: ["BraveSoftware/Brave-Browser/Application/brave.exe"],
  chrome: ["Google/Chrome/Application/chrome.exe"],
};
const find = (name) =>
  [LOCAL, ...PROGRAMS].map((root) => EXE[name].map((rel) => `${root}/${rel}`)).flat().find((p) => fs.existsSync(p));

/** Options for playwright's launchPersistentContext that select the browser. */
export function launchOptions() {
  if (BROWSER === "edge") return { channel: "msedge" };
  const executablePath = find(BROWSER);
  if (!executablePath) throw new Error(`${BROWSER} is not installed on this computer`);
  return { executablePath };
}

/** The address scheme of the browser's own pages (edge://version, brave://version, chrome://version). */
export const SCHEME = { edge: "edge", brave: "brave", chrome: "chrome" }[BROWSER];
/** The process name, used to clean up leftovers of a test run. */
export const PROCESS = { edge: "msedge.exe", brave: "brave.exe", chrome: "chrome.exe" }[BROWSER];

/**
 * Like chromium.launchPersistentContext(profile, options), for any of the three browsers.
 * Branded Chrome (137 and later) ignores --load-extension, so there the extension is installed the way the
 * browser's own developer tools do it: over the DevTools protocol (Extensions.loadUnpacked).
 */
export async function launch(chromium, profile, options) {
  if (BROWSER !== "chrome") return chromium.launchPersistentContext(profile, options);
  const { spawn } = await import("node:child_process");
  const extDir = options.args.find((a) => a.startsWith("--load-extension=")).split("=")[1];
  const args = options.args.filter((a) => !a.startsWith("--load-extension=") && !a.startsWith("--disable-extensions-except="));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(options.executablePath, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging", ...args, "about:blank"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!browser) { proc.kill(); throw new Error("could not connect to Chrome"); }
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: extDir });
  const ctx = browser.contexts()[0];
  await new Promise((r) => setTimeout(r, 2500)); // the first service worker may be replaced once the extension has settled
  ctx.close = async () => {
    try { await browser.close(); } catch { /* already gone */ }
    proc.kill();
  };
  return ctx;
}

/**
 * The extension's own service worker (a browser can have others of its own, built-in extensions for example).
 * Service workers are stopped by the browser when idle and started again on demand; the returned handle follows
 * that: if the worker was replaced between two calls, the call is repeated on the new one.
 */
export async function extensionWorker(ctx, timeout = 15000) {
  const { id } = JSON.parse(fs.readFileSync(new URL("../key.json", import.meta.url), "utf8"));
  const mine = (w) => w.url().startsWith(`chrome-extension://${id}/`);
  const find = async () => ctx.serviceWorkers().filter(mine).at(-1) ?? (await ctx.waitForEvent("serviceworker", { timeout, predicate: mine }));
  let worker = await find();
  return {
    url: () => worker.url(),
    async evaluate(fn, arg) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await worker.evaluate(fn, arg);
        } catch (e) {
          if (attempt >= 3 || !/restarted|closed|detached|not found|Target/i.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 400));
          worker = await find();
        }
      }
    },
  };
}

/** Remove a folder; a browser that is still shutting down may hold it for a moment, which is not a test failure. */
export function rmQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch {
    /* left for the system's temp cleanup */
  }
}

/**
 * The flag that makes the browser pick the window whose title starts with `title` by itself (no picker shown).
 * It must match the WINDOW and not the tab: a window's title carries the browser's name, a tab's does not.
 */
export function windowFlag(title) {
  const suffix = { edge: " and", brave: " - Brave", chrome: " - Google Chrome" }[BROWSER];
  return `--auto-select-desktop-capture-source=${title}${suffix}`;
}
