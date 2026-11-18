// Smoke test of the side panel UI (opened as a normal tab, which is how a test can reach it).
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--auto-accept-camera-and-microphone-capture", "--use-fake-device-for-media-stream", "--no-first-run", "--no-default-browser-check"],
});
try {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("sharing"), null, { timeout: 8000 });
  check(true, "the panel loads and shows the recorder's status", (await page.textContent("#status")).replace(/\s+/g, " "));
  check((await page.locator("button").count()) >= 9, "all the controls are there", `${await page.locator("button").count()} buttons`);
  await page.click("#mic");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Microphone allowed"), null, { timeout: 8000 });
  check(true, "'Allow microphone' grants it once for the extension");
  await page.click("#start");
  await page.waitForFunction(() => document.getElementById("err").textContent.length > 0, null, { timeout: 8000 });
  check(true, "Start before sharing the window explains itself instead of failing silently", (await page.textContent("#err")).slice(0, 90));
  check(errors.length === 0, "no script errors in the panel", errors.join(" | "));
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  for (const d of [profile, extDir]) fs.rmSync(d, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
}
