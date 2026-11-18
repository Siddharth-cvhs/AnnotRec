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
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (r?.error) throw new Error(r.error);
  return r;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("There is no active tab.");
  return tab;
}

const toTab = async (message) => chrome.tabs.sendMessage((await activeTab()).id, message);

const serverUrl = async () => (await chrome.storage.local.get("server")).server ?? "http://localhost:4000";

const api = {
  /** Where the AnnotRec server (our FFmpeg pipeline) is. */
  async setServer(url) {
    await chrome.storage.local.set({ server: url });
  },

  /** Share the browser window, once. The picture follows whichever tab is in front. */
  async pick(mode = "display") {
    await ensureOffscreen();
    if (mode === "display") return off({ type: "attachDisplay" });
    const streamId = await new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(["window"], resolve));
    if (!streamId) throw new Error("No window was chosen.");
    return off({ type: "attach", streamId });
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

  async start(options = {}) {
    const cal = await api.calibrate();
    await off({ type: "geometry", ...(await toTab({ type: "marker", on: false })) });
    // The recorder page has no storage access (offscreen pages only get the messaging API): pass the server address in.
    const { server } = await chrome.storage.local.get("server");
    const started = await off({ type: "start", server, ...options });
    return { ...started, calibration: cal };
  },

  stop: () => off({ type: "stop" }),
  pause: () => off({ type: "pause" }),
  resume: () => off({ type: "resume" }),
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

// ------------------------------------------------------------------ messages
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.target === "offscreen") return; // for the recorder
  if (m?.type === "api") {
    api[m.fn](...(m.args ?? [])).then(reply, (e) => reply({ error: String(e.message ?? e) }));
    return true;
  }
  if (m?.type === "geometry") {
    // Pages report their size; the recorder only cares about the tab that is in front.
    if (sender.tab?.active) chrome.runtime.sendMessage({ target: "offscreen", type: "geometry", ...m }).catch(() => {});
    reply?.({});
    return;
  }
  if (m?.type === "snapshot") {
    // A picture of the page (without our overlay, which is empty at that moment), to freeze it.
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then(
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
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Pages that were already open when the extension was installed get the content script too.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
});
