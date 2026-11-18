// Probe service worker: tries to capture tabs and reports exactly what the browser says.
self.probe = {
  async tabs() {
    const all = await chrome.tabs.query({});
    return all.filter((t) => /^http:\/\/localhost:50\d\d\//.test(t.url ?? "")).map((t) => ({ id: t.id, url: t.url, active: t.active, windowId: t.windowId }));
  },
  async streamId(tabId) {
    try {
      return { ok: true, id: await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }) };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  },
  async visibleTab(windowId) {
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return { ok: true, bytes: url.length };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  },
  async consume(streamId) {
    if (!(await chrome.offscreen.hasDocument?.())) {
      await chrome.offscreen.createDocument({ url: "off.html", reasons: ["USER_MEDIA"], justification: "probe" });
    }
    return chrome.runtime.sendMessage({ type: "consume", streamId });
  },
};
