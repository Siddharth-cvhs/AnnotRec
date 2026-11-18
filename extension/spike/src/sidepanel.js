// Side panel: the controls. It only sends commands to the service worker and shows the state.
const $ = (id) => document.getElementById(id);
const call = (fn, ...args) => chrome.runtime.sendMessage({ type: "api", fn, args });

async function run(fn, ...args) {
  $("err").textContent = "";
  const r = await call(fn, ...args);
  if (r?.error) $("err").textContent = r.error;
  refresh();
  return r;
}

// ------------------------------------------------------------ permissions
// The browser only shows its microphone prompt reliably from a normal tab, so "Allow microphone" opens one.
// Whenever something is not allowed, the panel says what, and offers the browser and Windows settings.
const openMicTab = () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });

async function micState() {
  try {
    const state = (await navigator.permissions.query({ name: "microphone" })).state; // granted | prompt | denied
    // A prompt answered "allow" is remembered by the browser; if it only counted for that one request, the
    // permission tab told us it was granted, so do not ask in a loop.
    if (state === "prompt" && (await chrome.storage.local.get("micGranted")).micGranted) return "granted";
    return state;
  } catch {
    return "prompt";
  }
}

function showHelp(text) {
  $("helptext").textContent = text;
  $("help").hidden = !text;
}

async function renderPerm() {
  const m = await micState();
  const s = await call("status");
  const chip = (cls, t) => `<span class="chip ${cls}">${t}</span>`;
  $("perm").innerHTML =
    chip(m === "granted" ? "ok" : m === "denied" ? "bad" : "", `Microphone: ${m === "granted" ? "allowed" : m === "denied" ? "blocked" : "not asked yet"}`) +
    chip(s?.sharing ? "ok" : "", `Window: ${s?.sharing ? "shared" : "not shared yet"}`);
  if (m === "granted") $("help").hidden = true;
  return m;
}

/** Share the window with the browser's picker; explains what happened if it was cancelled. */
async function ensureShared() {
  const s = await call("status");
  if (s?.sharing) return true;
  const r = await call("pick");
  if (r?.error) {
    $("err").textContent = /denied|dismiss|NotAllowed|cancel/i.test(r.error)
      ? "Window sharing was cancelled or blocked. Press Start again, then choose your Edge window (Window tab) and press Share."
      : r.error;
    return false;
  }
  return true;
}

async function ensureMic() {
  const m = await micState();
  if (m === "granted") return true;
  showHelp(
    m === "denied"
      ? "Microphone: Permission denied. The browser is blocking the microphone for AnnotRec. Open the settings and allow it, then ask again."
      : "The microphone is not allowed yet. A permission tab has opened: choose Allow in the browser's prompt.",
  );
  openMicTab();
  return false;
}

$("pick").onclick = async () => {
  $("err").textContent = "";
  await ensureShared();
  refresh();
};
$("mic").onclick = async () => {
  $("err").textContent = "";
  if ((await micState()) === "granted") {
    $("status").textContent = "Microphone is already allowed.";
    return;
  }
  await ensureMic();
};
$("helpallow").onclick = openMicTab;
$("helpedge").onclick = () => chrome.tabs.create({ url: "edge://settings/content/microphone" });
$("start").onclick = async () => {
  $("err").textContent = "";
  if (!(await ensureMic())) return;
  if (!(await ensureShared())) return refresh();
  const r = await run("start", { micOn: true });
  if (r?.micIssue) showHelp(`${r.micIssue} Check the microphone in the browser and Windows settings.`);
};
$("pause").onclick = () => run(paused ? "resume" : "pause");
$("stop").onclick = () => run("stop");
$("mute").onclick = (() => {
  let on = true;
  return () => run("setMic", (on = !on));
})();
let paused = false;
let folder = "";
const COLORS = ["#ef4444", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111827"];
let color = COLORS[5];
let tool = "pen";
let size = 4;
const style = () => ({ color, width: size });

for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "sw";
  b.style.background = c;
  b.title = c;
  b.dataset.color = c;
  b.onclick = async () => {
    color = c;
    await run("tool", tool, style());
  };
  $("colors").appendChild(b);
}
document.querySelectorAll("[data-tool]").forEach((b) => {
  b.onclick = async () => {
    tool = b.dataset.tool;
    await run("freeze"); // choosing a drawing tool freezes the page first
    await run("tool", tool, style());
  };
});
$("size").oninput = async () => {
  size = Number($("size").value);
  $("sizev").textContent = size;
  await run("tool", tool, style());
};
$("undo").onclick = () => run("undo");
$("redo").onclick = () => run("redo");
$("clear").onclick = () => run("clear");

async function refresh() {
  const s = await call("status");
  paused = !!s?.paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("pause").disabled = !s?.recording;
  $("status").textContent = s?.error
    ? s.error
    : `sharing: ${s.sharing}   calibrated: ${s.calibrated}\nrecording: ${s.paused ? "paused" : s.recording}   ${(s.elapsedMs / 1000).toFixed(1)} s`;
  const p = await call("pageState");
  if (p && !p.error) {
    tool = p.tool ?? tool;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", p.frozen && b.dataset.tool === p.tool));
    document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    $("undo").disabled = !p.frozen || !p.shapes;
    $("redo").disabled = !p.frozen || !p.canRedo;
  }
  renderPerm();
  const files = await call("list");
  $("files").innerHTML = Array.isArray(files)
    ? files
        .slice(0, 6)
        .map((f) => `<li><span>${f.name} (${(f.size / 1e6).toFixed(1)} MB${f.durationMs ? `, ${(f.durationMs / 1000).toFixed(0)} s` : ""})</span><button data-show="${f.name}">Show</button></li>`)
        .join("")
    : "";
  if (!folder) {
    const h = await call("health");
    if (h?.folder) {
      folder = h.folder;
      $("folder").textContent = `Saved in: ${folder}`;
    } else if (h?.error || !h) $("folder").textContent = "The AnnotRec server is not reachable. Start it with npm start.";
  }
}
setInterval(refresh, 1000);
refresh();

$("openfolder").onclick = () => run("reveal");
$("copyfolder").onclick = () => folder && navigator.clipboard.writeText(folder).then(() => ($("status").textContent = "Path copied."));
$("files").onclick = (e) => e.target.dataset.show && run("reveal", e.target.dataset.show);

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "permission" && m.mic === "granted") chrome.storage.local.set({ micGranted: true }).then(renderPerm);
});
