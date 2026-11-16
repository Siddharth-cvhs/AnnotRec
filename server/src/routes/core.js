// Health, target selection and the built-in sample page.

import express from "express";
import fs from "node:fs";
import { normalizeAddress } from "../util.js";

export function coreRoutes(router, ctx) {
  const { converter, targets, options } = ctx;

  router.get("/api/health", async (_req, res) => {
    res.json({
      ffmpeg: await converter.available(),
      proxyPort: options.proxyPort,
      target: targets.get(),
      qualities: converter.qualities,
    });
  });

  // Choose the page to show: { url } -> { viewportUrl, target }
  router.post("/api/target", express.json({ limit: "10kb" }), (req, res) => {
    const u = normalizeAddress(req.body?.url);
    if (!u) return res.status(400).json({ error: "That is not a valid http(s) address." });
    targets.set(u.origin);
    ctx.events.emit("target:changed", { url: u.href });
    res.json({ viewportUrl: `http://localhost:${options.proxyPort}${u.pathname}${u.search}${u.hash}`, target: u.href });
  });

  // The page the viewport shows until an address is chosen.
  router.get("/sample.html", (_req, res) => {
    const file = options.samplePage;
    file && fs.existsSync(file) ? res.sendFile(file) : res.status(404).end();
  });
}
