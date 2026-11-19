// Side panel: the controls. It only sends commands to the service worker and shows the state.
// Everything the user presses answers at once: the button changes state before the work is done ("Starting...",
// the chosen tool lights up), and the real state replaces it a moment later.
const $ = (id) => document.getElementById(id);
const call = (fn, ...args) => chrome.runtime.sendMessage({ type: "api", fn, args });
const B = self.annotBrowser;

const friendly = (e) =>
  /Receiving end does not exist|Cannot access|cannot be scripted|No tab with id|extensions gallery/i.test(e)
    ? "Drawing is not available on this page. Browser pages (settings, the extension store, new tab) cannot be drawn on. Open a normal website."
    : e;

async function run(fn, ...args) {
  $("err").textContent = "";
  const r = await call(fn, ...args);
  if (r?.error) $("err").textContent = friendly(r.error);
  refresh(); // not awaited: the answer is already here, the display catches up by itself
  return r;
}

// ------------------------------------------------------------------ one place that draws the recording bar
let uiBusy = null; // "starting" | "saving" while the work is under way
function paintBar(state, elapsedMs = 0, level = 0) {
  const bar = $("recbar");
  const shown = uiBusy ?? state;
  bar.className = `recbar ${shown}`;
  $("recstate").textContent = { starting: "Starting…", saving: "Saving…", rec: "Recording", paused: "Paused", idle: "Ready" }[shown];
  const sec = Math.floor(elapsedMs / 1000);
  $("clock").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  $("level").style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 100))}%`;
}
function setBusy(what) {
  uiBusy = what;
  $("start").disabled = !!what;
  $("stop").disabled = what === "saving";
  paintBar("idle");
}

// ------------------------------------------------------------------ permissions
// Microphone: three situations.
//  - not asked yet  -> a small AnnotRec tab opens and the browser shows its own permission prompt there
//                      (a side panel cannot show that prompt reliably)
//  - blocked        -> the browser cannot prompt any more, so the page where the block is lifted opens by itself
//                      (this extension's own site settings), with a plain explanation
//  - allowed        -> nothing to do
const openMicTab = () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
const openSiteSettings = () => chrome.tabs.create({ url: B.siteSettings });

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
// The moment the setting changes (in the prompt or in the settings page), the panel notices.
navigator.permissions?.query({ name: "microphone" }).then((p) => {
  p.onchange = async () => {
    if (p.state === "granted") await chrome.storage.local.set({ micGranted: true });
    renderPerm();
  };
}).catch(() => {});

function showHelp(text) {
  $("helptext").textContent = text;
  $("help").hidden = !text;
}

async function renderPerm(status) {
  const m = await micState();
  const s = status ?? (await call("status"));
  const chip = (cls, t) => `<span class="chip ${cls}">${t}</span>`;
  $("perm").innerHTML =
    chip(m === "granted" ? "ok" : m === "denied" ? "bad" : "", `Microphone: ${m === "granted" ? "allowed" : m === "denied" ? "blocked" : "not asked yet"}`) +
    chip(s?.sharing ? "ok" : "", `Window: ${s?.sharing ? "shared" : "not shared yet"}`);
  if (m === "granted") $("help").hidden = true;
  return m;
}

/** Make the browser deal with the microphone permission, whatever state it is in. Resolves true when it is allowed. */
async function requestMic() {
  const m = await micState();
  if (m === "granted") return true;
  if (m === "denied") {
    showHelp("Microphone: Permission denied. The browser is blocking the microphone for AnnotRec. I opened its setting: change Microphone to Allow (or Ask), then press the button again.");
    openSiteSettings();
  } else {
    showHelp("The microphone is not allowed yet. A permission tab has opened: choose Allow in the browser's prompt.");
    openMicTab();
  }
  return false;
}

/** Share the window with the browser's picker; explains what happened if it was cancelled. */
async function ensureShared(status) {
  if (status?.sharing) return true;
  const r = await call("pick");
  if (r?.error) {
    $("err").textContent = /denied|dismiss|NotAllowed|cancel/i.test(r.error)
      ? "Window sharing was cancelled or blocked. Press Start again, then choose this browser window (Window tab) and press Share."
      : r.error;
    return false;
  }
  return true;
}

$("pick").onclick = async () => {
  $("err").textContent = "";
  await ensureShared();
  refresh();
};
$("mic").onclick = async () => {
  $("err").textContent = "";
  if (await requestMic()) $("status").textContent = "Microphone is allowed ✓";
};
$("helpallow").onclick = async () => ((await micState()) === "denied" ? openSiteSettings() : openMicTab());
$("helpbrowser").onclick = () => chrome.tabs.create({ url: B.microphoneSettings });
$("helpbrowser").textContent = `${B.name} microphone settings`;
$("browsername").textContent = `${B.name} extension`;

// ------------------------------------------------------------------ recording
$("start").onclick = async () => {
  $("err").textContent = "";
  setBusy("starting"); // answers at once; everything below happens while this shows
  try {
    if (!(await requestMic())) return;
    const status = (await call("panelState"))?.status;
    if (!(await ensureShared(status))) return;
    const r = await call("start", { micOn: true });
    if (r?.error) $("err").textContent = friendly(r.error);
    else if (r?.micIssue) showHelp(`${r.micIssue} Check the microphone in the browser and Windows settings.`);
  } finally {
    setBusy(null);
    refresh();
  }
};
$("pause").onclick = () => {
  paused = !paused; // shown at once
  $("pause").textContent = paused ? "Resume" : "Pause";
  return run(paused ? "pause" : "resume");
};
$("stop").onclick = async () => {
  setBusy("saving");
  let r;
  try {
    r = await call("stop");
  } finally {
    setBusy(null);
    refresh();
  }
  if (r?.error) $("err").textContent = friendly(r.error);
  if (r?.saved) {
    lastSaved = r.saved.name;
    $("toasttext").textContent = `Saved ✓ ${r.saved.name} (${(r.durationMs / 1000).toFixed(0)} s, ${(r.saved.size / 1e6).toFixed(1)} MB)`;
    $("toast").hidden = false;
    $("toastshow").hidden = false;
  }
};
$("toastshow").onclick = () => lastSaved && run("reveal", lastSaved);
$("mute").onclick = (() => {
  let on = true;
  return () => run("setMic", (on = !on));
})();

// ------------------------------------------------------------------ drawing
let paused = false;
let folder = "";
let lastSaved = "";
const COLORS = ["#ef4444", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111827"];
let color = COLORS[5];
let tool = "pen";
let size = 4;
const style = () => ({ color, width: size });
const markSelected = (frozen = true) => {
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", frozen && b.dataset.tool === tool));
  document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
};
// One message does everything: freeze the page if it is not frozen yet, and choose the tool, colour and size.
const draw = async () => {
  markSelected(); // lit at once
  $("err").textContent = "";
  const r = await call("draw", tool, style());
  if (r?.error) {
    markSelected(false);
    $("err").textContent = friendly(r.error);
  }
};

for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "sw";
  b.style.background = c;
  b.title = c;
  b.dataset.color = c;
  b.onclick = () => {
    color = c;
    draw();
  };
  $("colors").appendChild(b);
}
document.querySelectorAll("[data-tool]").forEach((b) => {
  b.onclick = () => {
    tool = b.dataset.tool;
    draw();
  };
});
$("size").oninput = () => {
  size = Number($("size").value);
  $("sizev").textContent = size;
  call("tool", tool, style()); // only a setting: no need to wait for it or freeze anything
};
$("undo").onclick = () => call("undo");
$("redo").onclick = () => call("redo");
$("clear").onclick = () => {
  markSelected(false);
  return run("clear");
};

// ------------------------------------------------------------------ keeping the display true
let slowTick = 0;
async function refresh() {
  const { status: s, page: p } = (await call("panelState")) ?? {};
  paused = !!s?.paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("pause").disabled = !s?.recording;
  paintBar(s?.recording ? (s.paused ? "paused" : "rec") : "idle", s?.elapsedMs ?? 0, s?.micLevel ?? 0);
  if (s?.recording) $("toast").hidden = true;
  $("status").textContent = !s || s.error
    ? s?.error ?? "…"
    : `sharing: ${s.sharing}   calibrated: ${s.calibrated}\nrecording: ${s.paused ? "paused" : s.recording}   ${(s.elapsedMs / 1000).toFixed(1)} s`;
  $("pagehint").hidden = !p?.error;
  if (p?.error) $("pagehint").textContent = "Drawing is not available on this page (browser pages cannot be drawn on). Switch to a normal website.";
  if (p && !p.error) {
    tool = p.tool ?? tool;
    markSelected(p.frozen);
    $("undo").disabled = !p.frozen || !p.shapes;
    $("redo").disabled = !p.frozen || !p.canRedo;
  }
  if (slowTick++ % 4) return pace(!!s?.recording);
  renderPerm(s);
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
  pace(!!s?.recording);
}

// Fast while recording (clock and level meter), slow otherwise: an idle panel should cost the browser nothing.
let timer = 0;
let fast = null;
function pace(recording) {
  if (recording === fast) return;
  fast = recording;
  clearInterval(timer);
  timer = setInterval(refresh, recording ? 300 : 1200);
}
pace(false);
refresh();

$("openfolder").onclick = () => run("reveal");
$("copyfolder").onclick = () => folder && navigator.clipboard.writeText(folder).then(() => ($("status").textContent = "Path copied."));
$("files").onclick = (e) => e.target.dataset.show && run("reveal", e.target.dataset.show);

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "permission" && m.mic === "granted") chrome.storage.local.set({ micGranted: true }).then(() => renderPerm());
});

document.querySelectorAll("button[title]").forEach((b) => b.setAttribute("aria-label", b.title));

// ------------------------------------------------------------------ settings: the server address
(async () => {
  $("server").value = (await call("getServer"))?.server ?? "";
})();
$("saveserver").onclick = async () => {
  const r = await call("setServer", $("server").value.trim());
  $("err").textContent = r?.error ?? "";
  if (!r?.error) {
    $("server").value = r.server;
    folder = "";
    $("status").textContent = "Server address saved.";
  }
};

// ------------------------------------------------------------------ a recording that stopped by itself
function showEnded(e) {
  if (!e) return;
  $("toasttext").textContent = e.error ? `${e.reason} ${e.error}` : `${e.reason} ${e.name ?? ""}`.trim();
  $("toast").hidden = false;
  lastSaved = e.name ?? "";
  $("toastshow").hidden = !e.name;
}
chrome.storage.local.get("lastEnded").then(({ lastEnded }) => {
  if (lastEnded && Date.now() - lastEnded.at < 5 * 60_000) showEnded(lastEnded);
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "auto-stopped") showEnded({ reason: m.reason, name: m.saved?.name, error: m.error });
});

// ------------------------------------------------------------------ developer setting (only for an unpacked install)
(async () => {
  const r = await call("getAutoReload");
  if (!r?.unpacked) return;
  $("autoreloadrow").hidden = false;
  $("autoreload").checked = !!r.on;
})();
$("autoreload").onchange = () => call("setAutoReload", $("autoreload").checked);
