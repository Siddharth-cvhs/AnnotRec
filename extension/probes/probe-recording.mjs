// What can each installed browser record, directly? (decides whether Version 3 needs FFmpeg at all)
import { chromium } from "../../node_modules/playwright-core/index.mjs";

const L = process.env.LOCALAPPDATA;
const browsers = {
  Edge: { channel: "msedge" },
  Chrome: { executablePath: `${L}\\Google\\Chrome\\Application\\chrome.exe` },
  Brave: { executablePath: `${L}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` },
  Opera: { executablePath: `${L}\\Programs\\Opera\\opera.exe` },
};

const probe = () => {
  const mp4 = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
  return {
    ua: navigator.userAgent.match(/(Edg|Chrome|OPR)\/[\d.]+/g)?.join(" "),
    brave: !!navigator.brave,
    mp4H264Aac: MediaRecorder.isTypeSupported(mp4),
    mp4Any: MediaRecorder.isTypeSupported("video/mp4"),
    webmVp9: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus"),
    cropTarget: typeof CropTarget !== "undefined",
    webCodecs: typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined",
    opfs: !!navigator.storage?.getDirectory,
    saveFilePicker: "showSaveFilePicker" in window,
  };
};

for (const [name, opts] of Object.entries(browsers)) {
  let browser;
  try {
    browser = await chromium.launch({ headless: false, timeout: 25000, args: ["--no-first-run", "--no-default-browser-check"], ...opts });
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.fulfill({ body: "<html><body>probe</body></html>", contentType: "text/html" }));
    await page.goto("http://localhost:4999/", { timeout: 15000 });
    console.log(name.padEnd(7), JSON.stringify(await page.evaluate(probe)));
  } catch (e) {
    console.log(name.padEnd(7), "could not be driven:", e.message.split("\n")[0]);
  } finally {
    await browser?.close().catch(() => {});
  }
}
