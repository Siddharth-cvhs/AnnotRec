// Standalone AnnotRec: the API router plus the built React app on one local port.
// Everything binds to 127.0.0.1 and stays on this machine.
//
// To use AnnotRec inside another Node app instead, see server/src/annotrec.js.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnnotRec } from "./src/annotrec.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4000;
const DIST = path.join(ROOT, "client", "dist");

const annotrec = createAnnotRec({
  recDir: process.env.REC_DIR || path.join(ROOT, "recordings"),
  proxyPort: Number(process.env.PROXY_PORT) || PORT + 1,
});

const app = express();
app.disable("x-powered-by");
app.use(annotrec.router);

// The built React app (after `npm run build`). In development Vite serves it.
// Hashed assets never change, so the browser may keep them forever.
if (fs.existsSync(DIST)) {
  app.use("/assets", express.static(path.join(DIST, "assets"), { immutable: true, maxAge: "1y" }));
  app.use(express.static(DIST, { maxAge: 0 }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`AnnotRec 2.0 app:     http://localhost:${PORT}`);
  console.log(`Recordings saved to:  ${annotrec.ctx.storage.dir}`);
  console.log((await annotrec.ctx.converter.available()) ? "FFmpeg found: MP4 export ready." : "WARNING: FFmpeg not found. Install it or set FFMPEG_PATH, or MP4 export will fail.");
});

annotrec
  .startProxy()
  .then(() => console.log(`Viewport proxy:       http://localhost:${annotrec.ctx.options.proxyPort}`))
  .catch((e) => {
    console.error(`Cannot start the viewport proxy on port ${annotrec.ctx.options.proxyPort}: ${e.message}`);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => annotrec.close().finally(() => process.exit(0)));
