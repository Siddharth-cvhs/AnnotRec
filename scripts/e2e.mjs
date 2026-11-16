// End-to-end test: drives the real app in Microsoft Edge (visible window), walks
// through the Phase 1.0 demo scenario and saves the resulting MP4.
//
//   node scripts/e2e.mjs [outFile.mp4]
//
// Needs the server running (npm start) and Edge installed. Edge is started with
// flags that auto-accept "share this tab" and the microphone prompt and supply
// a fake microphone, so no one has to click through the permission dialogs.

import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const OUT = process.argv[2] || "e2e-output.mp4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[e2e] ${m}`);
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`ok   ${msg}`);
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
  args: [
    "--auto-accept-this-tab-capture",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--window-size=1500,900",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 820 } });
  page.on("console", (m) => m.type() === "error" && log(`browser error: ${m.text()}`));
  await page.goto(BASE);
  const frame = page.frameLocator("iframe");
  await frame.getByText("Acme Demo Site").waitFor();
  log("page loaded, sample page visible in the proxied iframe");

  const phase = () => page.getByTestId("phase").innerText();
  check((await phase()) === "READY", "starts READY");

  // --- 1. Start recording
  await page.getByTestId("start").click();
  await page.getByTestId("phase").filter({ hasText: "RECORDING" }).waitFor({ timeout: 15000 });
  check(true, "recording started (tab share accepted, mic opened)");
  await sleep(2500);

  // Interact with the live page (clicks go through to the iframe).
  await frame.getByText("Click me").click();
  await frame.getByText("Click me").click();
  check((await frame.locator("#n").innerText()) === "2", "live page is interactive while recording");

  // --- 2. Annotation: rectangle freezes the page
  await page.getByTestId("tool-rect").click();
  await page.getByText("Page frozen for annotation").waitFor({ timeout: 10000 });
  check(true, "choosing a tool froze the page (banner shown), recording continues");
  check((await phase()) === "RECORDING", "still RECORDING while frozen");

  // While frozen the iframe must not receive clicks: counter should stay 2.
  const canvas = page.getByTestId("overlay-canvas");
  const box = await canvas.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (a, b, steps = 12) => {
    await page.mouse.move(...at(...a));
    await page.mouse.down();
    await page.mouse.move(...at(...b), { steps });
    await page.mouse.up();
  };

  await drag([0.05, 0.12], [0.45, 0.4]); // rectangle
  await sleep(600);
  await page.getByTestId("tool-arrow").click();
  await drag([0.5, 0.55], [0.8, 0.3]);
  await sleep(600);
  await page.getByTestId("tool-ellipse").click();
  await drag([0.55, 0.6], [0.9, 0.9]);
  await page.getByTestId("tool-pen").click();
  await page.mouse.move(...at(0.1, 0.7));
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(...at(0.1 + i * 0.015, 0.7 + Math.sin(i / 2) * 0.04));
  await page.mouse.up();
  await page.getByTestId("tool-highlighter").click();
  await drag([0.05, 0.85], [0.4, 0.85]);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(...at(0.12, 0.2));
  await page.keyboard.type("REMOVE THIS");
  await page.keyboard.press("Enter");
  await sleep(800);
  check((await frame.locator("#n").innerText()) === "2", "frozen page ignored clicks (counter unchanged)");

  // Undo / redo / eraser
  await page.getByTestId("undo").click();
  await page.getByTestId("redo").click();
  await page.getByTestId("tool-eraser").click();
  await page.mouse.click(...at(0.2, 0.7)); // erase the pen stroke
  await sleep(1500);
  check(true, "undo, redo and eraser ran");

  // --- 3. Clear all returns to the live page
  await page.getByTestId("clear").click();
  await page.getByText("Page frozen for annotation").waitFor({ state: "detached", timeout: 5000 });
  check((await phase()) === "RECORDING", "Clear all kept recording");
  await frame.getByText("Click me").click();
  check((await frame.locator("#n").innerText()) === "3", "page is live again after Clear all");

  // --- 4. Mic toggle, pause / resume
  await page.getByTestId("mic").click();
  await page.getByText("MIC OFF").waitFor();
  await sleep(1000);
  await page.getByTestId("mic").click();
  await page.getByText("MIC ON").waitFor();

  await page.getByTestId("pause").click();
  await page.getByTestId("phase").filter({ hasText: "PAUSED" }).waitFor();
  const t1 = await page.getByTestId("timer").innerText();
  await sleep(2500);
  const t2 = await page.getByTestId("timer").innerText();
  check(t1 === t2, `timer stopped while paused (${t1})`);
  await page.getByTestId("resume").click();
  await page.getByTestId("phase").filter({ hasText: "RECORDING" }).waitFor();
  await sleep(2000);

  // --- 5. Screenshot
  await page.getByTestId("screenshot").click();
  await page.getByTestId("message").filter({ hasText: "Screenshot saved" }).waitFor({ timeout: 15000 });
  check(true, "screenshot saved");

  // --- 6. Stop and fetch the MP4
  await page.getByTestId("stop").click();
  await page.getByTestId("phase").filter({ hasText: "READY" }).waitFor({ timeout: 60000 });
  const files = await (await page.request.get(`${BASE}/api/recordings`)).json();
  const mp4 = files.find((f) => f.name.endsWith(".mp4"));
  check(!!mp4, `an MP4 was saved (${mp4?.name}, ${mp4?.size} bytes)`);
  const body = await (await page.request.get(`${BASE}/api/recordings/${mp4.name}`)).body();
  fs.writeFileSync(OUT, body);
  log(`saved ${OUT}`);
  log("ALL CHECKS PASSED");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
