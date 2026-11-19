// A short, quiet notice on the screen that is being shared, so you can tell which one it is. It closes by itself.
const kind = new URLSearchParams(location.search).get("kind") || "window";
const TEXT = {
  monitor: ["Sharing this screen", "AnnotRec records only the browser page on it."],
  window: ["Sharing this browser window", "The picture follows your tabs. Only the page is recorded."],
  browser: ["Sharing this tab", "Only this tab is recorded."],
};
const [title, sub] = TEXT[kind] ?? TEXT.window;
document.getElementById("t").textContent = title;
document.getElementById("s").textContent = sub;
setTimeout(() => document.getElementById("note").classList.add("out"), 2100);
setTimeout(() => window.close(), 2600);
