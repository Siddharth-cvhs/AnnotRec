// AnnotRec server, as a library.
//
//   import { createAnnotRec } from "./server/src/annotrec.js";
//   const annotrec = createAnnotRec({ recDir: "./videos", proxyPort: 4101 });
//   app.use("/tools/annotrec", annotrec.router);   // mount it anywhere
//   await annotrec.startProxy();                   // the viewport proxy port
//   annotrec.events.on("recording:saved", (file) => { ... });
//
// The router serves the API only (/api/*) plus /sample.html. Serving the built
// client is the host's choice (server/index.js shows the standalone way).
//
// Extension points:
//   - ports:   `storage` and `converter` options replace where files live and
//              how video is encoded
//   - events:  "recording:saved", "screenshot:saved", "file:removed", "target:changed"
//   - plugins: `plugins: [(ctx) => { ... }]` get { router, events, storage,
//              converter, targets, options, live }: add routes, middleware or
//              event listeners (e.g. upload every saved recording to a bucket)

import express from "express";
import { EventEmitter } from "node:events";
import { FFmpegConverter } from "./converter.js";
import { loopbackGuard } from "./guard.js";
import { LiveSessions } from "./live.js";
import { normalizeOptions } from "./options.js";
import { startViewportProxy } from "./proxy.js";
import { coreRoutes } from "./routes/core.js";
import { libraryRoutes } from "./routes/library.js";
import { liveRoutes } from "./routes/live.js";
import { FileStorage } from "./storage.js";
import { Targets } from "./targets.js";

export function createAnnotRec(userOptions = {}) {
  const options = normalizeOptions(userOptions);
  const events = new EventEmitter();
  const storage = options.storage ?? new FileStorage(options.recDir);
  const converter = options.converter ?? new FFmpegConverter(options.ffmpegPath);
  const targets = new Targets(null);
  const live = new LiveSessions({ storage, converter, events, idleMs: options.liveIdleMs });

  // Conversions of whole-file uploads run one at a time: two encoders would only slow each other down.
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const router = express.Router();
  if (options.guard === "loopback") router.use(loopbackGuard(options.allowedOrigins));
  else if (typeof options.guard === "function") router.use(options.guard);

  const ctx = { router, events, storage, converter, targets, options, live, enqueue };
  coreRoutes(router, ctx);
  libraryRoutes(router, ctx);
  liveRoutes(router, ctx);
  for (const plugin of options.plugins) plugin(ctx);

  let proxyServer = null;
  return {
    router,
    events,
    ctx,
    /** Starts the viewport proxy on `options.proxyPort` (127.0.0.1 only). */
    async startProxy() {
      proxyServer = await startViewportProxy({ port: options.proxyPort, targets });
      return proxyServer;
    },
    /** Sets the page the viewport shows (used by the standalone server for the sample page). */
    setTarget: (origin) => targets.set(origin),
    /** Stops the proxy and any running conversions. */
    async close() {
      live.close();
      await new Promise((resolve) => (proxyServer ? proxyServer.close(resolve) : resolve()));
    },
  };
}
