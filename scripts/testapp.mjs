// A stand-in for "the user's app" in tests. It behaves like a hostile-to-framing
// real app: it sends X-Frame-Options: DENY and a CSP with frame-ancestors 'none',
// uses a root-relative script, and has a redirect.
import http from "node:http";

export function startTestApp(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const base = {
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    };
    if (url.pathname === "/") {
      res.writeHead(200, { ...base, "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Test target</title>
<body style="margin:0;background:#00aa55;color:#fff;font:700 48px system-ui;display:grid;place-items:center;height:100vh">
<div>TEST TARGET<br><small id="s" style="font-size:20px">script not loaded</small>
<br><a id="r" href="/redirect" style="font-size:20px;color:#fff">redirect</a></div>
<script src="/app.js"></script>`);
    } else if (url.pathname === "/app.js") {
      res.writeHead(200, { ...base, "content-type": "text/javascript" });
      res.end(`document.getElementById("s").textContent = "script ok"; window.__loaded = true;`);
    } else if (url.pathname === "/redirect") {
      res.writeHead(302, { ...base, location: `http://localhost:${port}/page2` });
      res.end();
    } else if (url.pathname === "/page2") {
      res.writeHead(200, { ...base, "content-type": "text/html" });
      res.end(`<body style="background:#223;color:#fff;font:700 40px system-ui">PAGE TWO</body>`);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
