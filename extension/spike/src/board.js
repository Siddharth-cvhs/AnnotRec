// The drawing board: shows the picture of the browser page that is being drawn on, and says when it is ready.
const shot = document.getElementById("shot");
chrome.storage.session.get("boardShot").then(({ boardShot }) => {
  if (boardShot) shot.src = boardShot;
});
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === "boardReady") reply({ ready: shot.complete && shot.naturalWidth > 0 });
});
