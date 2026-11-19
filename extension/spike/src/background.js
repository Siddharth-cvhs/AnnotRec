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

const serverUrl = async () => (await chrome.storage.local.get("server")).server ?? "http://localhost:4000";

/** The toolbar icon says what is going on, even when the side panel is closed. */
function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
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
  async pick() {
    await ensureOffscreen();
    return off({ type: "attachDisplay" });
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

  /** Is the AnnotRec server there, and can it make MP4s? Asked before anything is captured. */
  async preflight() {
    const server = await serverUrl();
    let h;
    try {
      h = await (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(2500) })).json();
    } catch {
      throw new Error(`Cannot reach the AnnotRec server at ${server}. Start it (npm start) and try again.`);
    }
    if (!h.ffmpeg) throw new Error("The AnnotRec server cannot find FFmpeg, so it cannot make the MP4. Install FFmpeg and restart the server.");
    return { ok: true, folder: h.folder };
  },

  async start(options = {}) {
    const [, cal] = await Promise.all([api.preflight(), api.calibrate()]);
    await off({ type: "geometry", ...(await toTab({ type: "marker", on: false })) });
    // The recorder page has no storage access (offscreen pages only get the messaging API): pass the server address in.
    const { server } = await chrome.storage.local.get("server");
    const started = await off({ type: "start", server, ...options });
    badge("REC", "#ef4444");
    return { ...started, calibration: cal };
  },

  async stop() {
    badge("...", "#f59e0b"); // the MP4 is being finished
    try {
      return await off({ type: "stop" });
    } finally {
      badge("");
    }
  },
  async pause() {
    const r = await off({ type: "pause" });
    badge("II", "#f59e0b");
    return r;
  },
  async resume() {
    const r = await off({ type: "resume" });
    badge("REC", "#ef4444");
    return r;
  },
  status: () => off({ type: "status" }),
  peek: () => off({ type: "peek" }),
  setMic: (on) => off({ type: "mic", on }),

  // --- annotation (drives the page in front)
  freeze: () => toTab({ type: "freeze" }),
  tool: (tool, extra = {}) => toTab({ type: "tool", tool, ...extra }),
  undo: () => toTab({ type: "undo" }),
  redo: () => toTab({ type: "redo" }),
  clear: () => toTab({ type: "clear" }),
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
  if (m?.type === "auto-stopped") {
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
      const p = await api.pageState();
      if (p?.frozen) await api.clear();
      else {
        await api.freeze();
        await api.tool(p?.tool ?? "pen");
      }
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
