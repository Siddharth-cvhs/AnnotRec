// Which browser is this? The wording and the settings address differ (edge://, brave://, chrome://).
// Loaded by the pages of the extension before their own script.
(() => {
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  const brave = typeof navigator.brave !== "undefined";
  const edge = brands.includes("Microsoft Edge") || /\bEdg\//.test(navigator.userAgent);
  const name = brave ? "Brave" : edge ? "Edge" : "Chrome";
  const scheme = brave ? "brave" : edge ? "edge" : "chrome";
  self.annotBrowser = {
    name,
    scheme,
    microphoneSettings: `${scheme}://settings/content/microphone`,
    shortcutsPage: `${scheme}://extensions/shortcuts`,
    extensionsPage: `${scheme}://extensions`,
  };
})();
