// AnnotRec service worker: the orchestrator.
//
// It owns nothing that must survive (a service worker sleeps after ~30 s idle). The recorder lives in
// the offscreen document; this file only routes messages and talks to the page's content script.
//
// The same `api` object is used by the side panel (through messages) and by the tests (directly).

const OFFSCREEN = "offscreen.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Capture the browser window and the microphone and encode the recording.",
  });
}

/** Ask the offscreen recorder to do something. */
async function off(message) {
  if (message.type !== "status") reloadIfRebuilt(); // a rebuild is picked up whenever the extension is used
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (r?.error) throw new Error(r.error);
  return r;
}

async function activeTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url || /^chrome-extension:/.test(tab.url)) {
    // the controls were opened in their own window: use the page window behind it
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    if (win) [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  }
  if (!tab) throw new Error("There is no active tab.");
  return tab;
}

const toTab = async (message) => chrome.tabs.sendMessage((await activeTab()).id, message);

// ------------------------------------------------------------------ browser pages: drawing on a picture of them
// A browser page (new tab, settings, the extension store...) cannot run our drawing code. For those, drawing happens
// on a "board": a tab of our own that shows a picture of the page, with the normal drawing code on top of it.
// "Clear all" closes the board and returns to the real page.
const BOARD_URL = chrome.runtime.getURL("board.html");
const isBoard = (url) => !!url && url.startsWith(BOARD_URL);
const isRestricted = (url) =>
  !url ||
  /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-search|chrome-untrusted|chrome-error):/i.test(url) ||
  (/^chrome-extension:/i.test(url) && !isBoard(url)) ||
  /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url);

async function pictureOf(tab) {
  try {
    const r = await off({ type: "pagePicture", w: tab.width, h: tab.height });
    if (r.url) return r.url;
  } catch {
    /* not shared yet, or not measured: below */
  }
  if (!isRestricted(tab.url)) {
    // an ordinary page that refused our script: the browser's own page picture still works
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 96 });
    } catch {
      /* below */
    }
  }
  throw new Error("To draw on a browser page, share the window first (Get ready, step 2) while a normal website is open. AnnotRec then draws on a picture of this page.");
}

async function openBoard(tab) {
  const shot = await pictureOf(tab);
  await chrome.storage.session.set({ boardShot: shot });
  const board = await chrome.tabs.create({ url: `${BOARD_URL}?o=${tab.id}`, index: tab.index + 1, windowId: tab.windowId, active: true });
  // ready = the picture is loaded and the drawing code is running in it
  for (let i = 0; i < 100; i++) {
    try {
      if ((await chrome.tabs.sendMessage(board.id, { type: "boardReady" }))?.ready) break;
    } catch {
      /* the page is still loading */
    }
    await sleep(30);
  }
  return board;
}

async function closeBoard(tab) {
  let origin = 0;
  try {
    origin = Number(new URL(tab.url).searchParams.get("o"));
  } catch {
    /* no address */
  }
  if (origin) await chrome.tabs.update(origin, { active: true }).catch(() => {});
  await chrome.tabs.remove(tab.id).catch(() => {});
}

// ------------------------------------------------------------------ the light frame and the notice while sharing
async function prefs() {
  const s = await chrome.storage.local.get(["indicator", "announce"]);
  return { indicator: s.indicator ?? true, announce: s.announce ?? true };
}
/** mode: "off" | "shared" | "rec" | "paused". Every page shows a light frame at its edge in that colour (or none). */
async function setIndicator(mode) {
  const shown = (await prefs()).indicator ? mode : "off";
  await chrome.storage.session.set({ indicatorMode: shown, indicatorWanted: mode }).catch(() => {});
  for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, { type: "indicator", mode: shown }).catch(() => {});
}
/** A short, quiet notice at the top right of the browser window, so you can tell which screen is being shared. */
async function announceShare(surface) {
  if (!(await prefs()).announce) return;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (!win) return;
  const w = 360, h = 104;
  chrome.windows
    .create({
      url: chrome.runtime.getURL(`sharing.html?kind=${encodeURIComponent(surface ?? "window")}`),
      type: "popup",
      width: w,
      height: h,
      left: Math.max(0, (win.left ?? 0) + (win.width ?? 900) - w - 16),
      top: Math.max(0, (win.top ?? 0) + 6),
      focused: false,
    })
    .catch(() => {});
}

const serverUrl = async () => (await chrome.storage.local.get("server")).server ?? "http://localhost:4000";

/** The toolbar icon says what is going on, even when the side panel is closed. */
function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

let calibrating = null;
let preflightOk = null; // { server, at, result } of the last successful check
/** Measure the page unless the earlier measurement is still right for it (then nothing flashes and nothing waits). */
function ensureCalibrated() {
  calibrating ??= (async () => {
    const geometry = await toTab({ type: "marker", on: false }); // the page's current size (cheap)
    if ((await off({ type: "calValid", geometry })).valid) return { cached: true };
    return api.calibrate();
  })().finally(() => (calibrating = null));
  return calibrating;
}

const api = {
  /** Where the AnnotRec server (our FFmpeg pipeline) is. */
  async setServer(url) {
    // Recordings go only to a server on this computer: anything else is refused.
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error("That is not a valid address. Example: http://localhost:4000");
    }
    if (!["http:", "https:"].includes(u.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
      throw new Error("For safety the server must be on this computer (localhost or 127.0.0.1).");
    }
    await chrome.storage.local.set({ server: u.origin });
    return { ok: true, server: u.origin };
  },

  async getServer() {
    return { server: await serverUrl() };
  },

  /** Developer setting: reload by itself after a rebuild (default: on in Edge only). */
  async getAutoReload() {
    return { on: await autoReloadOn(), unpacked: IS_UNPACKED };
  },
  async setAutoReload(on) {
    await chrome.storage.local.set({ autoReload: !!on });
    return { ok: true };
  },

  /** Share the browser window, once. The picture follows whichever tab is in front. */
  async pick({ announce = false } = {}) {
    await ensureOffscreen();
    const shared = await off({ type: "attachDisplay" });
    setIndicator("shared");
    if (announce) announceShare(shared.surface); // only when a person pressed Share (not in automated runs)
    // Now that the window is shared, do the slow one-time things so that Start is quick: measure where the page sits
    // in the window picture, and warm up the audio system.
    ensureCalibrated().catch(() => {});
    off({ type: "prewarm" }).catch(() => {});
    api.preflight().catch(() => {});
    return shared;
  },

  /**
   * Measure where the page sits inside the captured window: the page briefly draws a magenta frame at its
   * edges, the recorder finds it in the picture. Done before recording starts, so it is never recorded.
   */
  async calibrate() {
    const geometry = await toTab({ type: "marker", on: true });
    await sleep(150); // the recorder keeps looking for the marker for a few seconds, so no long fixed wait is needed
    try {
      return await off({ type: "calibrate", geometry });
    } finally {
      await toTab({ type: "marker", on: false }).catch(() => {});
    }
  },

  /** Is the AnnotRec server there, and can it make MP4s? Asked before anything is captured (and remembered briefly). */
  async preflight() {
    const server = await serverUrl();
    if (preflightOk && preflightOk.server === server && Date.now() - preflightOk.at < 30_000) return preflightOk.result;
    let h;
    try {
      h = await (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(2500) })).json();
    } catch {
      throw new Error(`Cannot reach the AnnotRec server at ${server}. Start it (npm start) and try again.`);
    }
    if (!h.ffmpeg) throw new Error("The AnnotRec server cannot find FFmpeg, so it cannot make the MP4. Install FFmpeg and restart the server.");
    preflightOk = { server, at: Date.now(), result: { ok: true, folder: h.folder } };
    return preflightOk.result;
  },

  async start(options = {}) {
    const t0 = performance.now();
    // The recorder page has no storage access (offscreen pages only get the messaging API): pass the server address in.
    const { server } = await chrome.storage.local.get("server");
    // 1. The slow things begin right now and run side by side: the microphone and the server session...
    await off({ type: "prepare", server, ...options });
    try {
      // 2. ...while the server is checked and the page is measured (if it was not measured already).
      // (a measurement that did not find the page is tried once more: the marker can reach the capture a moment late)
      const measure = () => ensureCalibrated().catch((e) => (/cannot (see|find)/i.test(String(e.message)) ? api.calibrate() : Promise.reject(e)));
      const [, cal] = await Promise.all([api.preflight(), measure()]);
      const t1 = performance.now();
      await off({ type: "geometry", ...(await toTab({ type: "marker", on: false })) });
      const t2 = performance.now();
      const started = await off({ type: "start", server, ...options });
      badge("REC", "#ef4444");
      setIndicator("rec");
      const t3 = performance.now();
      return { ...started, calibration: cal, timings: { checkAndMeasureMs: Math.round(t1 - t0), geometryMs: Math.round(t2 - t1), recorderMs: Math.round(t3 - t2), totalMs: Math.round(t3 - t0), inside: started.timings } };
    } catch (e) {
      await off({ type: "cancelPrepare" }).catch(() => {});
      await calibrating?.catch(() => {}); // a measurement still under way finishes (and takes its marker away) before the next try
      throw e;
    }
  },

  async stop() {
    badge("...", "#f59e0b"); // the MP4 is being finished
    try {
      return await off({ type: "stop" });
    } finally {
      badge("");
      setIndicator((await off({ type: "status" }).catch(() => null))?.share ? "shared" : "off");
    }
  },
  async pause() {
    const r = await off({ type: "pause" });
    badge("II", "#f59e0b");
    setIndicator("paused");
    return r;
  },
  async resume() {
    const r = await off({ type: "resume" });
    badge("REC", "#ef4444");
    setIndicator("rec");
    return r;
  },
  status: () => off({ type: "status" }),
  peek: () => off({ type: "peek" }),
  setMic: (on) => off({ type: "mic", on }),

  // --- annotation (drives the page in front)
  freeze: () => api.draw(undefined),
  /**
   * Freeze the page if it is not frozen, and choose the tool, colour and size: one message instead of three.
   * On a browser page (which cannot run our code) a board with a picture of the page opens first.
   */
  async draw(tool, extra = {}) {
    const tab = await activeTab();
    if (isRestricted(tab.url)) await openBoard(tab);
    try {
      return await toTab({ type: "draw", tool, ...extra });
    } catch (e) {
      if (!/Receiving end does not exist/i.test(String(e.message ?? e)) || isBoard(tab.url)) throw e;
      await openBoard(tab); // the page refused our script (a policy, a local file...): draw on a picture of it
      return toTab({ type: "draw", tool, ...extra });
    }
  },
  /** Everything the panel shows, in one answer. */
  async panelState() {
    const tab = await activeTab().catch(() => null);
    const restricted = !!tab && isRestricted(tab.url) && !isBoard(tab.url);
    const [status, page] = await Promise.all([
      off({ type: "status" }).catch((e) => ({ error: String(e.message ?? e) })),
      restricted ? { restricted: true } : api.pageState().catch((e) => ({ error: String(e.message ?? e) })),
    ]);
    return { status, page };
  },
  tool: (tool, extra = {}) => toTab({ type: "tool", tool, ...extra }),
  undo: () => toTab({ type: "undo" }),
  redo: () => toTab({ type: "redo" }),
  async clear() {
    const tab = await activeTab().catch(() => null);
    const r = await toTab({ type: "clear" }).catch(() => ({ ok: true }));
    if (tab && isBoard(tab.url)) {
      await sleep(170); // after the drawing's fade-out
      await closeBoard(tab); // and back to the real page
    }
    return r;
  },

  async getPrefs() {
    return prefs();
  },
  async setPrefs(p) {
    await chrome.storage.local.set({ ...(p.indicator !== undefined && { indicator: !!p.indicator }), ...(p.announce !== undefined && { announce: !!p.announce }) });
    const { indicatorWanted } = await chrome.storage.session.get("indicatorWanted");
    await setIndicator(indicatorWanted ?? "off");
    return { ok: true };
  },
  pageState: () => toTab({ type: "state" }),

  async list() {
    return (await fetch(`${await serverUrl()}/api/recordings`)).json();
  },

  /** { folder, ffmpeg, ... }: where the server saves recordings. */
  async health() {
    return (await fetch(`${await serverUrl()}/api/health`)).json();
  },

  /** Show a saved file in Explorer (no name: open the recordings folder). */
  async reveal(name) {
    const r = await fetch(`${await serverUrl()}/api/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    });
    if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error ?? `reveal ${r.status}`);
    return { ok: true };
  },
};
self.api = api;

// ------------------------------------------------------------------ development: reload after a rebuild
// An unpacked extension is read from disk. `node build.mjs` writes version.txt; when it changes and nothing is being
// recorded, the extension reloads itself, so you never have to press the reload arrow. (Not used in a packed build.)
const IS_UNPACKED = !chrome.runtime.getManifest().update_url;
// Self-reload is on by default only where it is proven to work (Edge). In Chrome and Brave it is a setting that is off
// by default: if a build of the browser cannot bring an extension back after chrome.runtime.reload(), the developer's
// extension would vanish. (Settings in the side panel: "Reload automatically after a rebuild".)
const IS_EDGE = (navigator.userAgentData?.brands ?? []).some((x) => x.brand === "Microsoft Edge") || /Edg\//.test(navigator.userAgent);
async function autoReloadOn() {
  const { autoReload } = await chrome.storage.local.get("autoReload");
  return autoReload ?? IS_EDGE;
}
let myVersion = null;
let lastCheck = 0;
async function reloadIfRebuilt() {
  if (!IS_UNPACKED || Date.now() - lastCheck < 3000) return;
  lastCheck = Date.now();
  try {
    if (!(await autoReloadOn())) return;
    const v = (await (await fetch(chrome.runtime.getURL("version.txt"), { cache: "no-store" })).text()).trim();
    if (myVersion === null) myVersion = v;
    else if (v !== myVersion && !(await off({ type: "status" })).busy) chrome.runtime.reload();
  } catch {
    /* no version file: nothing to do */
  }
}
reloadIfRebuilt();

// ------------------------------------------------------------------ messages
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.target === "offscreen") return; // for the recorder
  if (m?.type === "api") {
    reloadIfRebuilt();
    api[m.fn](...(m.args ?? [])).then(reply, (e) => reply({ error: String(e.message ?? e) }));
    return true;
  }
  if (m?.type === "getIndicator") {
    chrome.storage.session.get("indicatorMode").then((s) => reply({ mode: s.indicatorMode ?? "off" }));
    return true;
  }
  if (m?.type === "cleared") {
    // everything was cleared on a drawing board (the Esc key, for example): back to the real page
    if (sender.tab && isBoard(sender.tab.url)) setTimeout(() => closeBoard(sender.tab), 170);
    reply?.({});
    return;
  }
  if (m?.type === "share-ended") {
    setIndicator("off");
    return;
  }
  if (m?.type === "auto-stopped") {
    setIndicator("off");
    badge("!", "#ef4444");
    setTimeout(() => badge(""), 5000);
    chrome.storage.local.set({ lastEnded: { at: Date.now(), reason: m.reason, name: m.saved?.name ?? null, error: m.error ?? null } }).catch(() => {});
    return;
  }
  if (m?.type === "geometry") {
    // Pages report their size; the recorder only cares about the tab that is in front.
    if (sender.tab?.active) chrome.runtime.sendMessage({ target: "offscreen", type: "geometry", ...m }).catch(() => {});
    reply?.({});
    return;
  }
  if (m?.type === "snapshot") {
    // A picture of the page (without our overlay, which is empty at that moment), to freeze it.
    // Chrome allows two of these per second. Freezing, clearing and freezing again quickly (the draw shortcut) can
    // exceed that: wait out the quota and try once more instead of failing.
    const take = () => chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 96 });
    take()
      .catch(async (e) => {
        if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String(e.message ?? e))) throw e;
        await sleep(600);
        return take();
      })
      .then(
        (url) => reply({ url }),
        (e) => reply({ error: String(e.message ?? e) }),
      );
    return true;
  }
});

// The tab in front changed: its page tells the recorder its size, so the crop follows.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.sendMessage(tabId, { type: "report" }).catch(() => {});
});

// Toolbar icon opens the side panel (the controls live beside the page, never inside the recording).
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.onClicked.addListener(async () => {
    const existing = (await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] })).find((w) => w.tabs?.some((t) => t.url?.startsWith(chrome.runtime.getURL("sidepanel.html"))));
    if (existing) return chrome.windows.update(existing.id, { focused: true });
    chrome.windows.create({ url: "sidepanel.html", type: "popup", width: 400, height: 820 });
  });
}

// Pages that were already open when the extension was installed get the content script too.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
});

// ------------------------------------------------------------------ keyboard shortcuts
// Work from any page, so a demo never needs the mouse on the side panel. (Change them on the browser's extension shortcuts page.)
async function onCommand(command, tab) {
  try {
    const s = await off({ type: "status" });
    if (command === "toggle-record") {
      if (s.recording) await api.stop();
      else await api.start({ micOn: true });
    } else if (command === "toggle-pause") {
      if (s.recording) await (s.paused ? api.resume() : api.pause());
    } else if (command === "toggle-draw") {
      const p = await api.pageState().catch(() => null); // null on a browser page: the draw call opens a board for it
      if (p?.frozen) await api.clear();
      else await api.draw(p?.tool ?? "pen");
    }
  } catch (e) {
    self.lastCommandError = String(e.message ?? e);
    // Not ready (window not shared, microphone not allowed...): show the side panel, which explains and fixes it.
    badge("!", "#ef4444");
    setTimeout(() => badge(""), 3000);
    if (tab?.windowId && chrome.sidePanel?.open) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
}
self.onCommand = onCommand; // also callable from tests
chrome.commands.onCommand.addListener(onCommand);
