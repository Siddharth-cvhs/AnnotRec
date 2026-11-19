// A normal extension tab whose only job is to make the browser show the microphone prompt.
// (The side panel cannot show it reliably, and the recorder page is hidden.)
// Granting here is for the whole extension: the recorder then uses the microphone without asking again.
const $ = (id) => document.getElementById(id);

const HELP = {
  blocked: [
    "Click the 🔒 icon (or the microphone icon) at the left of the address bar of this tab and set Microphone to <b>Allow</b>, or press <b>Open browser microphone settings</b> and remove AnnotRec from the Blocked list.",
    "Press <b>Try again</b>.",
  ],
  system: [
    "Windows can be blocking the microphone for all apps. Press <b>Open Windows microphone settings</b> and switch <b>Microphone access</b> and <b>Let desktop apps access your microphone</b> to On.",
    "Make sure a microphone is plugged in and not used exclusively by another program.",
    "Press <b>Try again</b>.",
  ],
};

function show(kind, text) {
  $("msg").className = kind === "ok" ? "ok" : "bad";
  $("msg").textContent = text;
}

async function ask() {
  $("fix").hidden = true;
  $("browsersettings").hidden = $("sitesettings").hidden = $("win").hidden = true;
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    show("ok", "Microphone allowed. You can close this tab; recording will have your voice.");
    chrome.storage.local.set({ micGranted: true }); // remembered even if the side panel is not open right now
    chrome.runtime.sendMessage({ type: "permission", mic: "granted" }).catch(() => {});
    setTimeout(() => window.close(), 1400);
  } catch (e) {
    const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
    const system = e.name === "NotReadableError" || e.name === "AbortError" || e.name === "NotFoundError";
    show("bad", denied ? `Microphone: Permission denied (${e.message}).` : `Microphone: ${e.name}: ${e.message}`);
    $("steps").innerHTML = (denied ? HELP.blocked : HELP.system).map((s) => `<li>${s}</li>`).join("");
    $("fix").hidden = false;
    $("browsersettings").hidden = false;
    $("sitesettings").hidden = !denied; // the one click that lifts the block
    $("win").hidden = !(system || denied);
  }
}

$("retry").onclick = ask;
$("sitesettings").onclick = () => chrome.tabs.create({ url: self.annotBrowser.siteSettings });
$("browsersettings").onclick = () => chrome.tabs.create({ url: self.annotBrowser.microphoneSettings });
$("browsersettings").textContent = `Open ${self.annotBrowser.name} microphone settings`;
ask();
