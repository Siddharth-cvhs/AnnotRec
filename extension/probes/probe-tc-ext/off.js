// Offscreen probe page: turns a tab capture stream id into real frames and reports their size and colour.
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type !== "consume") return;
  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
      });
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      document.body.appendChild(video);
      await video.play();
      const frame = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no frame within 5 s")), 5000);
        video.requestVideoFrameCallback(() => { clearTimeout(t); resolve(); });
      });
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(video, 0, 0);
      const px = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      stream.getTracks().forEach((t) => t.stop());
      reply({ ok: true, width: c.width, height: c.height, centre: [px[0], px[1], px[2]] });
    } catch (e) {
      reply({ ok: false, error: String(e.message ?? e) });
    }
  })();
  return true;
});
