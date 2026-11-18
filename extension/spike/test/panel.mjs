// The side panel and the permission flow (the panel is opened as a normal tab, which is how a test can reach it).
//   node test/panel.mjs
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const ROOT = path.resolve(SPIKE, "..", "..");
const { id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(SPIKE, "key.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-ext-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), extDir], { stdio: "ignore" });
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extrec-"));
const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, PORT: "4606", PROXY_PORT: "4607", REC_DIR: recDir, ANNOTREC_ALLOWED_ORIGINS: `chrome-extension://${EXT_ID}` },
  stdio: "ignore",
});
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4606/api/health")).ok) break; } catch { /* starting */ } await sleep(200); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-extprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, timeout: 40000,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--auto-accept-camera-and-microphone-capture", "--use-fake-device-for-media-stream", "--no-first-run", "--no-default-browser-check"],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  await sw.evaluate(() => self.api.setServer("http://localhost:4606"));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("sharing"), null, { timeout: 8000 });
  check(true, "the panel loads and shows the recorder's status", (await page.textContent("#status")).replace(/\s+/g, " "));
  check((await page.locator("button").count()) >= 9, "all the controls are there", `${await page.locator("button").count()} buttons`);

  await page.waitForFunction(() => document.getElementById("folder").textContent.startsWith("Saved in:"), null, { timeout: 8000 });
  const shown = (await page.textContent("#folder")).replace("Saved in: ", "");
  check(path.resolve(shown) === path.resolve(recDir), "the panel says which folder the videos are saved in", shown);
  check((await page.textContent("#perm")).includes("Microphone: not asked yet"), "a chip says the microphone has not been asked yet");

  // Start with the microphone not allowed: the panel opens the browser's permission tab by itself.
  const opened = ctx.waitForEvent("page", { timeout: 8000 });
  await page.click("#start");
  const permTab = await opened;
  check(permTab.url().endsWith("/permission.html"), "Start without microphone permission opens the permission tab", permTab.url().split("/").pop());
  check(await page.isVisible("#help"), "the panel explains why and offers the settings buttons");
  await permTab.waitForFunction(() => document.getElementById("msg").textContent.includes("allowed"), null, { timeout: 8000 });
  check(true, "the permission tab asks the browser and the microphone is granted");
  await page.waitForFunction(() => document.getElementById("perm").textContent.includes("Microphone: allowed"), null, { timeout: 8000 });
  check(true, "the panel's chip turns to 'allowed' afterwards");

  // The denied case: the browser (or Windows) refuses. The tab must say so plainly and show the way out.
  const denied = await ctx.newPage();
  await denied.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
  });
  await denied.goto(`chrome-extension://${EXT_ID}/permission.html`);
  await denied.waitForFunction(() => document.getElementById("msg").textContent.includes("Permission denied"), null, { timeout: 5000 });
  check(true, "a refused microphone says 'Microphone: Permission denied'");
  check((await denied.isVisible("#edge")) && (await denied.isVisible("#win")) && (await denied.isVisible("#steps")), "and shows the Edge settings, the Windows settings and the steps");
  const href = await denied.getAttribute("#win", "href");
  check(href === "ms-settings:privacy-microphone", "the Windows button points at Windows' microphone privacy page", href);
  check(errors.length === 0, "no script errors in the panel", errors.join(" | "));
} catch (e) {
  console.log("  FAIL  crashed:", e.message.split("\n")[0]);
  results.push(false);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
  for (const d of [profile, extDir, recDir]) fs.rmSync(d, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
}
