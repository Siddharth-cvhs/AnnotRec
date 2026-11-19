// Side panel: the controls. It only sends commands to the service worker and shows the state.
// Everything the user presses answers at once: the button changes state before the work is done ("Starting...",
// the chosen tool lights up), and the real state replaces it a moment later. Changes of state are animated
// (see ui.css and sidepanel.css), never abrupt.
const $ = (id) => document.getElementById(id);
const call = (fn, ...args) => chrome.runtime.sendMessage({ type: "api", fn, args });
const B = self.annotBrowser;

const friendly = (e) =>
  /Receiving end does not exist|Cannot access|cannot be scripted|No tab with id|extensions gallery/i.test(e)
    ? "Drawing is not available on this page. Browser pages (settings, the extension store, new tab) cannot be drawn on. Open a normal website."
    : e;

// ------------------------------------------------------------------ small display helpers
/** Show or hide an element; a shown one slides in (the animation restarts every time). */
function reveal(el, on) {
  if (on) {
    const was = el.hidden;
    el.hidden = false;
    if (was) {
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  } else el.hidden = true;
}
/** The red box for what went wrong; an empty text hides it. */
function setErr(text) {
  $("errtext").textContent = text;
  reveal($("err"), !!text);
}
/** A short confirmation that fades away by itself. */
let snackTimer = 0;
function notify(text) {
  const s = $("snack");
  s.textContent = text;
  s.classList.add("show");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => s.classList.remove("show"), 2400);
}
const setIcon = (btn, name) => btn.querySelector("use")?.setAttribute("href", `#i-${name}`);

async function run(fn, ...args) {
  setErr("");
  const r = await call(fn, ...args);
  if (r?.error) setErr(friendly(r.error));
  refresh(); // not awaited: the answer is already here, the display catches up by itself
  return r;
}

// ------------------------------------------------------------------ the recording bar and its buttons
let uiBusy = null; // "starting" | "saving" while the work is under way
function paintBar(state, elapsedMs = 0, level = 0) {
  const shown = uiBusy ?? state;
  $("recbar").className = `recbar ${shown}`;
  document.body.dataset.state = shown;
  $("recactions").dataset.state = shown === "paused" ? "paused" : shown === "rec" || shown === "saving" ? "rec" : "idle";
  // the group that is out of sight must not be reachable by keyboard or screen reader
  document.querySelector(".g-rec").toggleAttribute("inert", $("recactions").dataset.state === "idle");
  document.querySelector(".g-idle").toggleAttribute("inert", $("recactions").dataset.state !== "idle");
  $("recstate").textContent = { starting: "Starting…", saving: "Saving…", rec: "Recording", paused: "Paused", idle: "Ready" }[shown];
  const sec = Math.floor(elapsedMs / 1000);
  $("clock").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  $("level").style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 100))}%`;
  $("start").querySelector("span").textContent = shown === "starting" ? "Starting…" : "Start recording";
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
  reveal($("help"), !!text);
  applySetupFold();
}

// The "Get ready" card opens while something is missing and folds away by itself once everything is set.
let setupUserChoice = null; // null: automatic; true/false: the user opened or closed it by hand
let setupReady = false;
function applySetupFold() {
  const open = setupUserChoice ?? (!setupReady || !$("help").hidden);
  $("setupfold").classList.toggle("closed", !open);
  $("setupfold").toggleAttribute("inert", !open);
  $("setup").classList.toggle("collapsed", !open);
  $("setuptoggle").setAttribute("aria-expanded", String(open));
}
$("setuptoggle").onclick = () => {
  setupUserChoice = $("setupfold").classList.contains("closed");
  applySetupFold();
};

async function renderPerm(status) {
  const m = await micState();
  const s = status ?? (await call("status"));
  const micOk = m === "granted";
  const shared = !!s?.sharing;
  const chip = (cls, t) => `<span class="chip ${cls}">${t}</span>`;
  $("perm").innerHTML =
    chip(micOk ? "ok" : m === "denied" ? "bad" : "", `Microphone: ${micOk ? "allowed" : m === "denied" ? "blocked" : "not asked yet"}`) +
    chip(shared ? "ok" : "", `Window: ${shared ? "shared" : "not shared yet"}`);
  $("step-mic").className = `step ${micOk ? "done" : m === "denied" ? "bad" : ""}`;
  $("micline").textContent = micOk ? "Allowed ✓" : m === "denied" ? "Blocked by the browser. Press Fix." : "Not allowed yet";
  $("mic").textContent = m === "denied" ? "Fix" : "Allow";
  $("step-win").className = `step ${shared ? "done" : ""}`;
  const KIND = { monitor: "Entire screen", window: "Browser window", browser: "Browser tab" };
  $("winline").textContent = shared
    ? `Shared ✓ ${KIND[s.share?.surface] ?? "Browser window"}${s.share?.width ? ` · ${s.share.width}×${s.share.height}` : ""}${s.share?.surface === "monitor" ? " (the browser must be on it)" : ""}`
    : "Pick the browser window (or a screen with the browser on it)";
  const missing = (micOk ? 0 : 1) + (shared ? 0 : 1);
  setupReady = missing === 0;
  $("setupbadge").textContent = setupReady ? "Ready ✓" : `${missing} step${missing > 1 ? "s" : ""} left`;
  $("setupbadge").className = `pill ${setupReady ? "ok" : ""}`;
  $("setup").classList.toggle("done", setupReady);
  if (micOk) reveal($("help"), false);
  applySetupFold();
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
  const r = await call("pick", { announce: true });
  if (r?.error) {
    setErr(
      /denied|dismiss|NotAllowed|cancel/i.test(r.error)
        ? "Window sharing was cancelled or blocked. Press Start again, then choose this browser window (Window tab) and press Share."
        : r.error,
    );
    return false;
  }
  return true;
}

$("pick").onclick = async () => {
  setErr("");
  $("pick").disabled = true;
  try {
    await ensureShared();
  } finally {
    $("pick").disabled = false;
    refresh();
  }
};
$("mic").onclick = async () => {
  setErr("");
  if (await requestMic()) notify("Microphone is allowed ✓");
};
$("helpallow").onclick = async () => ((await micState()) === "denied" ? openSiteSettings() : openMicTab());
$("helpbrowser").onclick = () => chrome.tabs.create({ url: B.microphoneSettings });
$("helpbrowser").textContent = `${B.name} microphone settings`;
$("browsername").textContent = `${B.name} extension`;

// ------------------------------------------------------------------ recording
$("start").onclick = async () => {
  setErr("");
  setBusy("starting"); // answers at once; everything below happens while this shows
  try {
    if (!(await requestMic())) return;
    const status = (await call("panelState"))?.status;
    if (!(await ensureShared(status))) return;
    const r = await call("start", { micOn: true });
    if (r?.error) setErr(friendly(r.error));
    else if (r?.micIssue) showHelp(`${r.micIssue} Check the microphone in the browser and Windows settings.`);
  } finally {
    setBusy(null);
    refresh();
  }
};
$("pause").onclick = () => {
  paused = !paused; // shown at once
  $("pause").querySelector(".lbl").textContent = paused ? "Resume" : "Pause";
  setIcon($("pause"), paused ? "play" : "pause");
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
  if (r?.error) setErr(friendly(r.error));
  if (r?.saved) {
    slowTick = 0; // the list of videos refreshes right away
    lastSaved = r.saved.name;
    $("toasttext").textContent = `Saved ✓ ${r.saved.name} (${(r.durationMs / 1000).toFixed(0)} s, ${(r.saved.size / 1e6).toFixed(1)} MB)`;
    $("toastshow").hidden = false;
    reveal($("toast"), true);
  }
};
$("toastshow").onclick = () => lastSaved && run("reveal", lastSaved);
$("mute").onclick = (() => {
  let on = true;
  return () => {
    on = !on;
    $("mute").classList.toggle("muted", !on);
    setIcon($("mute"), on ? "mic" : "micoff");
    notify(on ? "Microphone on" : "Microphone muted");
    return run("setMic", on);
  };
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
const paintSize = () => {
  const dot = $("sizedot");
  const px = Math.round(4 + size * 1.7);
  dot.style.width = dot.style.height = `${px}px`;
  dot.style.background = color;
};
const markSelected = (frozen = true) => {
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", frozen && b.dataset.tool === tool));
  document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
  $("drawstate").textContent = frozen ? "drawing" : "live";
  $("drawstate").className = `pill ${frozen ? "accent" : ""}`;
  paintSize();
};
// One message does everything: freeze the page if it is not frozen yet, and choose the tool, colour and size.
const draw = async () => {
  markSelected(); // lit at once
  setErr("");
  const r = await call("draw", tool, style());
  if (r?.error) {
    markSelected(false);
    setErr(friendly(r.error));
  }
};

for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "sw";
  b.style.background = c;
  b.title = c;
  b.setAttribute("aria-label", `Colour ${c}`);
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
  paintSize();
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
  document.body.classList.remove("loading");
  paused = !!s?.paused;
  $("pause").querySelector(".lbl").textContent = paused ? "Resume" : "Pause";
  setIcon($("pause"), paused ? "play" : "pause");
  $("pause").disabled = !s?.recording;
  paintBar(s?.recording ? (s.paused ? "paused" : "rec") : "idle", s?.elapsedMs ?? 0, s?.micLevel ?? 0);
  if (s?.recording) reveal($("toast"), false);
  $("status").textContent = !s || s.error
    ? s?.error ?? "…"
    : `sharing: ${s.sharing}   calibrated: ${s.calibrated}\nrecording: ${s.paused ? "paused" : s.recording}   ${(s.elapsedMs / 1000).toFixed(1)} s`;
  reveal($("pagehint"), !!p?.error || !!p?.restricted);
  $("pagehint").className = `alert ${p?.error ? "warn" : "info"}`;
  if (p?.restricted) {
    $("pagehint").textContent = s?.sharing
      ? "This is a browser page. Press a tool and AnnotRec draws on a picture of it; Clear all returns to the page."
      : "This is a browser page. Share the window first (Get ready), then press a tool to draw on a picture of it.";
  } else if (p?.error) {
    $("pagehint").textContent = "Drawing could not start on this page. Switch to another tab and try again.";
  }
  if (p && !p.error && !p.restricted) {
    tool = p.tool ?? tool;
    markSelected(p.frozen);
    $("undo").disabled = !p.frozen || !p.shapes;
    $("redo").disabled = !p.frozen || !p.canRedo;
  } else {
    markSelected(false);
    $("undo").disabled = $("redo").disabled = true;
  }
  if (slowTick++ % 4) return pace(!!s?.recording);
  renderPerm(s);
  const files = await call("list");
  renderFiles(Array.isArray(files) ? files : []);
  if (!folder) {
    const h = await call("health");
    if (h?.folder) {
      folder = h.folder;
      $("folder").textContent = `Saved in: ${folder}`;
      $("folder").title = folder;
    } else if (h?.error || !h) $("folder").textContent = "The AnnotRec server is not reachable. Start it with npm start.";
  }
  pace(!!s?.recording);
}

let shownFiles = "";
function renderFiles(files) {
  const top = files.slice(0, 6);
  const key = JSON.stringify(top.map((f) => [f.name, f.size]));
  if (key === shownFiles) return; // unchanged: leave the list alone (no flicker)
  shownFiles = key;
  $("empty").hidden = top.length > 0;
  $("files").innerHTML = top
    .map((f) => {
      const when = new Date(f.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const meta = [f.durationMs ? `${(f.durationMs / 1000).toFixed(0)} s` : null, `${(f.size / 1e6).toFixed(1)} MB`, when].filter(Boolean).join(" · ");
      return `<li><span class="fi"><svg class="i"><use href="#i-film"/></svg></span><span class="ft"><b title="${f.name}">${f.name}</b><small>${meta}</small></span><button class="btn sm" data-show="${f.name}" title="Show in folder">Show</button></li>`;
    })
    .join("");
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
markSelected(false); // the size preview and the colour ring are right from the first moment
refresh();

$("openfolder").onclick = () => run("reveal");
$("copyfolder").onclick = () => folder && navigator.clipboard.writeText(folder).then(() => notify("Folder path copied"));
$("files").onclick = (e) => e.target.dataset.show && run("reveal", e.target.dataset.show);

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "permission" && m.mic === "granted") chrome.storage.local.set({ micGranted: true }).then(() => renderPerm());
});

document.querySelectorAll("button[title]").forEach((b) => b.setAttribute("aria-label", b.getAttribute("aria-label") ?? b.title));

// ------------------------------------------------------------------ settings: the server address
(async () => {
  $("server").value = (await call("getServer"))?.server ?? "";
})();
$("saveserver").onclick = async () => {
  const r = await call("setServer", $("server").value.trim());
  setErr(r?.error ?? "");
  if (!r?.error) {
    $("server").value = r.server;
    folder = "";
    notify("Server address saved");
  }
};

// ------------------------------------------------------------------ a recording that stopped by itself
function showEnded(e) {
  if (!e) return;
  $("toasttext").textContent = e.error ? `${e.reason} ${e.error}` : `${e.reason} ${e.name ?? ""}`.trim();
  lastSaved = e.name ?? "";
  $("toastshow").hidden = !e.name;
  reveal($("toast"), true);
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

// ------------------------------------------------------------------ settings: the light frame and the notice
(async () => {
  const p = await call("getPrefs");
  $("pref-indicator").checked = !!p?.indicator;
  $("pref-announce").checked = !!p?.announce;
})();
$("pref-indicator").onchange = () => call("setPrefs", { indicator: $("pref-indicator").checked });
$("pref-announce").onchange = () => call("setPrefs", { announce: $("pref-announce").checked });
