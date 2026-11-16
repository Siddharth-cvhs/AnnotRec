// Visual review: screenshots of the UI in each state and at several window sizes.
//   node scripts/shots.mjs <outDir>
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const OUT = process.argv[2] || "shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
  args: ["--auto-accept-this-tab-capture", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

async function open(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("annotrecTest", "1"));
  await page.goto(BASE);
  await page.frameLocator("iframe").getByText("Portfolio Dashboard").waitFor();
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  // 1. Idle at three sizes
  for (const [w, h] of [[1480, 820], [1920, 1010], [1100, 680], [860, 600]]) {
    const { ctx, page } = await open(w, h);
    await shot(page, `idle-${w}x${h}`);
    await ctx.close();
  }

  const { ctx, page } = await open(1480, 820);
  await page.getByTestId("open-help").click();
  await sleep(500);
  await shot(page, "help");
  await page.keyboard.press("Escape");
  await page.getByTestId("open-settings").click();
  await sleep(500);
  await shot(page, "settings");
  await page.getByTestId("modal-close").click();

  // 2. Record with a countdown, freeze, ink of every kind
  await page.getByTestId("start").click();
  await page.getByTestId("countdown").waitFor();
  await sleep(300);
  await shot(page, "countdown");
  await page.getByTestId("phase").filter({ hasText: "RECORDING" }).waitFor({ timeout: 15000 });
  await sleep(1500);
  await shot(page, "recording-live");

  await page.getByTestId("tool-rect").click();
  await page.getByTestId("frozen-badge").waitFor();
  const box = await page.getByTestId("overlay-canvas").boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (a, b) => {
    await page.mouse.move(...at(...a));
    await page.mouse.down();
    await page.mouse.move(...at(...b), { steps: 10 });
    await page.mouse.up();
  };
  await drag([0.04, 0.1], [0.36, 0.34]);
  await page.getByTestId("tool-arrow").click();
  await drag([0.5, 0.5], [0.78, 0.3]);
  await page.getByTestId("tool-ellipse").click();
  await drag([0.55, 0.58], [0.9, 0.88]);
  await page.getByTestId("tool-marker").click();
  await page.mouse.click(...at(0.08, 0.14));
  await page.mouse.click(...at(0.6, 0.38));
  await page.getByTestId("tool-text").click();
  await page.mouse.click(...at(0.1, 0.5));
  await page.keyboard.type("Move this module");
  await page.keyboard.press("Enter");
  await page.getByTestId("tool-select").click();
  await page.mouse.click(...at(0.1, 0.52)); // select the text
  await sleep(500);
  await shot(page, "recording-frozen-ink");

  await page.getByTestId("pause").click();
  await shot(page, "paused");
  await page.getByTestId("resume").click();
  await page.getByTestId("clear").click();
  await sleep(500);

  // 3. Stop -> saving -> library
  await page.getByTestId("stop").click();
  await page.getByTestId("saving").waitFor();
  await shot(page, "saving");
  await page.getByTestId("phase").filter({ hasText: "READY" }).waitFor({ timeout: 60000 });
  await page.getByTestId("toast-success").waitFor();
  await shot(page, "saved-toast");

  await page.getByTestId("file").first().getByRole("button", { name: /Open/ }).first().click();
  await page.getByTestId("player-video").waitFor();
  await sleep(800);
  await shot(page, "player");
  await ctx.close();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
