// The library: whole-file upload, screenshots, listing, download, delete, reveal.

import express from "express";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

export function libraryRoutes(router, ctx) {
  const { storage, converter, events, options } = ctx;

  /**
   * Upload a whole recording (raw WebM body) and get an MP4 back. This is the
   * fallback for the live path. The reply is JSON lines:
   *   {"progress":0..1}  while converting, then {"done":{name,size,durationMs}} or {"error":"..."}.
   * Query: quality=<one of converter.qualities>, durationMs=<recorded length, for the progress>.
   */
  router.post("/api/recordings", async (req, res) => {
    const name = storage.newName("recording", "mp4");
    const tmp = storage.tempPath(name);
    const part = storage.partPath(name);
    const quality = converter.qualities.includes(req.query.quality) ? req.query.quality : converter.qualities[0];
    const expectedMs = Math.max(0, Number(req.query.durationMs) || 0);

    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    const send = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);
    const abort = new AbortController();
    res.on("close", () => !res.writableFinished && abort.abort());
    const cleanup = () => fs.rmSync(tmp, { force: true });

    try {
      let received = 0;
      req.on("data", (c) => {
        received += c.length;
        if (received > options.maxUploadBytes) req.destroy(new Error("The recording is too large."));
      });
      await pipeline(req, fs.createWriteStream(tmp));
      if (fs.statSync(tmp).size === 0) throw new Error("The recording was empty.");
      send({ progress: 0 });
      const durationMs = await ctx.enqueue(() =>
        converter.start(tmp, part, {
          quality,
          signal: abort.signal,
          onProgress: (ms) => send({ progress: expectedMs ? Math.min(0.99, ms / expectedMs) : 0 }),
        }).promise,
      );
      cleanup();
      const saved = storage.commit(name, { durationMs: Math.round(durationMs) });
      events.emit("recording:saved", { ...saved, path: storage.pathOf(name) });
      send({ done: saved });
    } catch (e) {
      cleanup();
      storage.discardPart(name);
      send({ error: String(e.message ?? e) });
    } finally {
      res.end();
    }
  });

  // Screenshots (PNG body) are saved next to the recordings.
  router.post("/api/screenshots", async (req, res) => {
    const name = storage.newName("screenshot", "png");
    try {
      await pipeline(req, fs.createWriteStream(storage.partPath(name)));
      const saved = storage.commit(name);
      events.emit("screenshot:saved", { ...saved, path: storage.pathOf(name) });
      res.json({ name, size: saved.size });
    } catch (e) {
      storage.discardPart(name);
      res.status(500).json({ error: String(e.message ?? e) });
    }
  });

  router.get("/api/recordings", (_req, res) => res.json(storage.list()));

  // Stream a file (for the in-page player, with range requests) or download it (?download=1).
  router.get("/api/recordings/:name", (req, res) => {
    const file = storage.pathOf(req.params.name);
    if (!file) return res.status(400).end();
    if (!storage.exists(req.params.name)) return res.status(404).end();
    req.query.download ? res.download(file, req.params.name) : res.sendFile(file);
  });

  router.delete("/api/recordings/:name", (req, res) => {
    if (!storage.remove(req.params.name)) return res.status(400).end();
    events.emit("file:removed", { name: req.params.name });
    res.status(204).end();
  });

  // Show a saved file in Windows Explorer (this is a local tool).
  router.post("/api/reveal", express.json({ limit: "10kb" }), (req, res) => {
    if (process.platform !== "win32") return res.status(501).json({ error: "Only available on Windows." });
    if (!req.body?.name) {
      // no file named: open the recordings folder itself
      spawn("explorer.exe", [storage.dir], { detached: true, stdio: "ignore" }).unref();
      return res.status(204).end();
    }
    const file = storage.pathOf(req.body.name);
    if (!file || !storage.exists(req.body.name)) return res.status(404).json({ error: "File not found." });
    spawn("explorer.exe", [`/select,${file}`], { detached: true, stdio: "ignore" }).unref();
    res.status(204).end();
  });
}
