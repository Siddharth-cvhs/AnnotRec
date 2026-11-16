// The viewport proxy.
//
// The page being recorded is shown in an <iframe>, but many apps refuse to be
// framed (X-Frame-Options, CSP frame-ancestors). This small reverse proxy sits
// on its own port, forwards everything to the chosen target and strips those
// headers. Using a whole port (instead of a path prefix) keeps root-relative
// URLs like "/assets/app.js" working, and WebSockets (hot reload) pass through.
//
// It only listens on 127.0.0.1: it forwards to whatever URL the user picked, so
// it must never be reachable from the network.

import http from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";

/** Removes the response headers that stop a page from being framed. */
function allowFraming(proxyRes) {
  const h = proxyRes.headers;
  delete h["x-frame-options"];
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    if (typeof h[name] === "string") {
      const kept = h[name]
        .split(";")
        .filter((d) => !d.trim().toLowerCase().startsWith("frame-ancestors"))
        .join(";");
      if (kept.trim()) h[name] = kept;
      else delete h[name];
    }
  }
}

/** @param {{ port: number, targets: import("./targets.js").Targets }} opts */
export function startViewportProxy({ port, targets }) {
  const proxy = createProxyMiddleware({
    router: () => targets.get() ?? "http://127.0.0.1:1",
    changeOrigin: true,
    ws: true,
    secure: false, // dev targets often use self-signed certificates
    autoRewrite: true, // redirects stay on the proxy
    cookieDomainRewrite: "",
    on: {
      proxyRes: allowFraming,
      error: (err, _req, res) => {
        if (res && typeof res.writeHead === "function" && !res.headersSent) {
          res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<body style="font:15px system-ui;padding:32px;color:#444"><h3>Cannot reach the page</h3><p>${String(
              err.message,
            ).replace(/</g, "&lt;")}</p><p>Is the app running at <b>${targets.get() ?? "(no address set)"}</b>?</p></body>`,
          );
        }
      },
    },
  });
  const server = http.createServer(proxy);
  server.on("upgrade", proxy.upgrade);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
