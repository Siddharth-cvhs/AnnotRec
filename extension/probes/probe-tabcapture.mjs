// Which permission setup lets one extension capture tabs WITHOUT a click on each tab?
//   node probe-tabcapture.mjs
//
// Loads probe-tc-ext into Edge in several setups and, for each, asks the browser
// to capture (1) the tab in front, (2) a tab that is in the background, and really
// consumes the stream to see whether frames arrive and what colour they are.
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SRC = path.join(HERE, "probe-tc-ext");
const { key, id: EXT_ID } = JSON.parse(fs.readFileSync(path.join(HERE, "..", "spike", "key.json"), "utf8"));

// Two pages with very different colours, so a captured frame tells us which tab we really got.
const server = http.createServer((req, res) => {
  const colour = req.url.startsWith("/b") ? "#0000ff" : "#00aa00";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<body style="margin:0;background:${colour}"><h1 style="color:#fff">${req.url}</h1>`);
});
await new Promise((r) => server.listen(5071, "127.0.0.1", r));

const setups = [
  { name: "activeTab only (no host permission)", host: [], flags: [] },
  { name: "host permission <all_urls>", host: ["<all_urls>"], flags: [] },
  { name: "<all_urls> + --whitelisted-extension-id", host: ["<all_urls>"], flags: [`--whitelisted-extension-id=${EXT_ID}`] },
];

for (const s of setups) {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-tc-ext-"));
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(ext, f));
  fs.writeFileSync(
    path.join(ext, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "probe tabcapture",
      version: "0.0.1",
      key,
      permissions: ["tabCapture", "tabs", "activeTab", "offscreen", "scripting"],
      host_permissions: s.host,
      background: { service_worker: "sw.js" },
      action: { default_title: "probe" },
    }),
  );
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-tc-prof-"));
  let ctx;
  console.log(`\n### ${s.name}`);
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel: "msedge",
      headless: false,
      timeout: 40000,
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-features=CalculateNativeWinOcclusion",
        "--no-first-run",
        "--no-default-browser-check",
        ...s.flags,
      ],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
    const a = await ctx.newPage();
    await a.goto("http://localhost:5071/a");
    const b = await ctx.newPage();
    await b.goto("http://localhost:5071/b");
    await b.bringToFront(); // b is in front, a is in the background
    await new Promise((r) => setTimeout(r, 800));
    const tabs = await sw.evaluate(() => self.probe.tabs());
    const front = tabs.find((t) => t.url.endsWith("/b"));
    const back = tabs.find((t) => t.url.endsWith("/a"));

    for (const [label, tab] of [["front tab (/b, blue)", front], ["background tab (/a, green)", back]]) {
      const sid = await sw.evaluate((id) => self.probe.streamId(id), tab.id);
      let line = `  ${label}: getMediaStreamId -> ${sid.ok ? "OK" : "REFUSED: " + sid.error}`;
      if (sid.ok) {
        const got = await sw.evaluate((id) => self.probe.consume(id), sid.id).catch((e) => ({ ok: false, error: e.message }));
        line += got.ok ? ` | frames arrive ${got.width}x${got.height}, centre pixel rgb(${got.centre})` : ` | consume failed: ${got.error}`;
      }
      console.log(line);
    }
    const vt = await sw.evaluate((w) => self.probe.visibleTab(w), front.windowId);
    console.log(`  captureVisibleTab (front): ${vt.ok ? "OK (" + vt.bytes + " chars)" : "REFUSED: " + vt.error}`);
  } catch (e) {
    console.log("  setup failed:", e.message.split("\n")[0]);
  } finally {
    await ctx?.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
}
server.close();
