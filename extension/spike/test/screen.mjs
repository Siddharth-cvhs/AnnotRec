// Sharing an ENTIRE SCREEN instead of a window. Only the measuring is done (nothing is recorded or saved), so the
// contents of the screen are looked at in memory for a moment and thrown away.
//   node test/screen.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BROWSER, launch, launchOptions, extensionWorker, rmQuiet } from "./browser.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>SpikeWindow M</title><body style="margin:0;background:#00aa00">`); });
await new Promise((r) => site.listen(5089, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const SCREEN = process.env.SCREEN || "Screen 1";
const ctx = await launch(chromium, profile, {
  ...launchOptions(), headless: false, timeout: 40000, viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion",
    `--auto-select-desktop-capture-source=${SCREEN}`, "--window-position=40,40", "--window-size=1200,800", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = await extensionWorker(ctx);
  const api = (fn, ...args) => sw.evaluate(([f, a]) => self.api[f](...a).then((r) => r, (e) => ({ error: String(e.message ?? e) })), [fn, args]);
  const P = await ctx.newPage();
  await P.goto("http://localhost:5089/");
  await P.bringToFront();
  for (let i = 0; i < 40; i++) { if (!(await api("pageState")).error) break; await sleep(150); }

  const shared = await Promise.race([api("pick"), sleep(12000).then(() => ({ timeout: true }))]);
  if (shared.timeout || shared.error || shared.surface !== "monitor") {
    console.log(`  SKIP  this browser did not pick "${SCREEN}" by itself here (${shared.error ?? shared.surface ?? "no answer"}); set SCREEN=<the source name> to try another`);
  } else {
    check(shared.surface === "monitor", "an entire screen is recognised as such", shared.surface);
    await sleep(6000); // the page is measured right after sharing (looking for it can take a few seconds)
    if (process.env.DEBUG) console.log("  debug calibrate:", JSON.stringify(await api("calibrate")).slice(0, 300));
    const st = await api("status");
    check(st.share?.surface === "monitor" && st.share.width > 800, "the status names it: the screen's size", `${st.share?.width}x${st.share?.height}`);
    check(st.calibrated === true, "the page is found inside the screen picture (browser on the shared screen)");
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
    await panel.waitForFunction(() => document.getElementById("winline").textContent.startsWith("Shared"), null, { timeout: 8000 });
    const line = await panel.textContent("#winline");
    check(/Entire screen/.test(line) && /browser must be on it/.test(line), "the panel says \"Entire screen\" and that the browser must be on it", line.slice(0, 80));
    await P.bringToFront();

    // the browser leaves the shared screen (here: minimised): measuring fails with a plain explanation
    await sw.evaluate(async () => { const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); await chrome.windows.update(w.id, { state: "minimized" }); });
    await sleep(900);
    const lost = await api("calibrate");
    check(/on the screen you shared/.test(lost.error ?? ""), "when the page is not on the shared screen it says what to do", (lost.error ?? "").slice(0, 90));
  }
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
