// Live conversion endpoints (see ../live.js).

export function liveRoutes(router, ctx) {
  const { live, converter, events, storage } = ctx;

  router.post("/api/live", (req, res) => {
    const quality = converter.qualities.includes(req.query.quality) ? req.query.quality : converter.qualities[0];
    // ?video=copy: the browser already sends H.264, only repackage it (see converter.js)
    res.json({ id: live.open(quality, { videoCopy: req.query.video === "copy" }) });
  });

  router.post("/api/live/:id/chunk", async (req, res) => {
    const s = live.get(req.params.id);
    if (!s) return res.status(404).json({ error: "No such recording session." });
    try {
      await live.append(s, req);
      res.status(204).end();
    } catch (e) {
      res.status(500).json({ error: String(e.message ?? e) });
    }
  });

  // Ends the session and streams progress, then the saved file (same lines as POST /api/recordings).
  router.post("/api/live/:id/finish", async (req, res) => {
    const s = live.get(req.params.id);
    if (!s) return res.status(404).json({ error: "No such recording session." });
    const expectedMs = Math.max(0, Number(req.query.durationMs) || 0);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    const send = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);
    res.on("close", () => !res.writableFinished && s.abort.abort());
    try {
      const saved = await live.finish(s, {
        onProgress: (ms) => send({ progress: expectedMs ? Math.min(0.99, ms / expectedMs) : 0 }),
      });
      events.emit("recording:saved", { ...saved, path: storage.pathOf(saved.name) });
      send({ done: saved });
    } catch (e) {
      send({ error: String(e.message ?? e) });
    } finally {
      res.end();
    }
  });

  router.delete("/api/live/:id", (req, res) => {
    live.abort(req.params.id);
    res.status(204).end();
  });
}
