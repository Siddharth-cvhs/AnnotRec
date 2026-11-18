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

$("pick").onclick = () => run("pick");
$("mic").onclick = async () => {
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    $("err").textContent = "";
    $("status").textContent = "Microphone allowed.";
  } catch (e) {
    $("err").textContent = `Microphone: ${e.message}`;
  }
};
$("start").onclick = () => run("start", { micOn: true });
$("stop").onclick = () => run("stop");
$("mute").onclick = (() => {
  let on = true;
  return () => run("setMic", (on = !on));
})();
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
  $("status").textContent = s?.error
    ? s.error
    : `sharing: ${s.sharing}   calibrated: ${s.calibrated}\nrecording: ${s.recording}   ${(s.elapsedMs / 1000).toFixed(1)} s`;
  const p = await call("pageState");
  if (p && !p.error) {
    tool = p.tool ?? tool;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", p.frozen && b.dataset.tool === p.tool));
    document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    $("undo").disabled = !p.frozen || !p.shapes;
    $("redo").disabled = !p.frozen || !p.canRedo;
  }
  const files = await call("list");
  $("files").innerHTML = Array.isArray(files)
    ? files.slice(0, 6).map((f) => `<li>${f.name} (${(f.size / 1e6).toFixed(1)} MB)</li>`).join("")
    : "";
}
setInterval(refresh, 1000);
refresh();
