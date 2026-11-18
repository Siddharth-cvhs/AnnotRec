// Request guard. The API drives the file system and a proxy, so by default it
// only answers requests that come from this machine's own pages: the Host must
// be loopback (stops DNS rebinding) and, when the browser says where a request
// came from, that must be a loopback page too (stops other websites calling it).
//
// Exception: origins listed in `allowedOrigins` (for example a browser extension
// "chrome-extension://<id>") may call the API. List exact origins only.
//
// When AnnotRec is mounted inside a bigger app that has its own authentication,
// pass `guard: false` (or your own middleware) to createAnnotRec().

import { hostnameOf, LOOPBACK } from "./util.js";

export function loopbackGuard(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const hostOk = LOOPBACK.has(hostnameOf(req.headers.host ?? ""));
    const origin = req.headers.origin;
    const originOk = !origin || LOOPBACK.has(hostnameOf(origin)) || allowed.has(origin);
    if (!hostOk || !originOk) return res.status(403).json({ error: "Forbidden." });
    next();
  };
}
