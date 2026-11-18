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
document.querySelectorAll("[data-tool]").forEach((b) => {
  b.onclick = async () => {
    await run("freeze"); // choosing a drawing tool freezes the page first
    await run("tool", b.dataset.tool);
  };
});
$("clear").onclick = () => run("clear");

async function refresh() {
  const s = await call("status");
  $("status").textContent = s?.error
    ? s.error
    : `sharing: ${s.sharing}   calibrated: ${s.calibrated}\nrecording: ${s.recording}   ${(s.elapsedMs / 1000).toFixed(1)} s`;
  const files = await call("list");
  $("files").innerHTML = Array.isArray(files)
    ? files.slice(0, 6).map((f) => `<li>${f.name} (${(f.size / 1e6).toFixed(1)} MB)</li>`).join("")
    : "";
}
setInterval(refresh, 1000);
refresh();
