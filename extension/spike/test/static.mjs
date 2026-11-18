// Quality gate that needs no browser: the manifest, permissions, files, icons and source rules.
//   node test/static.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SPIKE = path.join(HERE, "..");
const results = [];
const check = (ok, msg, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${detail ? `   (${detail})` : ""}`); };

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "annotrec-static-"));
spawnSync(process.execPath, [path.join(SPIKE, "build.mjs"), dist], { stdio: "ignore" });
const read = (f) => fs.readFileSync(path.join(dist, f), "utf8");
const m = JSON.parse(read("manifest.json"));

check(m.manifest_version === 3, "Manifest V3");
check(/^\d+\.\d+\.\d+$/.test(m.version), "a real version number", m.version);
check(m.name === "AnnotRec" && m.description.length > 20 && m.description.length <= 132, "a proper name and a store-length description", `${m.description.length} characters`);

const ALLOWED = ["offscreen", "sidePanel", "storage", "tabs", "scripting"];
const extra = m.permissions.filter((p) => !ALLOWED.includes(p));
check(extra.length === 0, "no permission beyond the five needed", extra.join(",") || m.permissions.join(","));
check(!m.permissions.includes("desktopCapture") && !m.permissions.includes("tabCapture"), "no capture permission (the standard picker needs none)");
check(JSON.stringify(m.host_permissions) === JSON.stringify(["<all_urls>"]), "page access is the one thing needed to draw on any site");
check(!m.optional_permissions && !m.externally_connectable && !m.web_accessible_resources, "nothing exposed to websites or other extensions");

const refs = new Set(["background.js", "sidepanel.html", "offscreen.html", "permission.html", "version.txt", ...(m.content_scripts ?? []).flatMap((c) => c.js), ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {})]);
const missing = [...refs].filter((f) => !fs.existsSync(path.join(dist, f)));
check(missing.length === 0, "every file the manifest and pages refer to is in the build", missing.join(",") || `${refs.size} files`);
check(Object.keys(m.icons ?? {}).length === 4, "icons in four sizes");
const png = (f) => { const b = fs.readFileSync(path.join(dist, f)); return b.length > 100 && b.readUInt32BE(16) > 0 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
check(Object.entries(m.icons ?? {}).every(([size, f]) => { const d = png(f); return d && d[0] === Number(size) && d[1] === Number(size); }), "each icon is really the size its name says");

const js = fs.readdirSync(dist).filter((f) => f.endsWith(".js"));
const html = fs.readdirSync(dist).filter((f) => f.endsWith(".html"));
const bad = [];
for (const f of js) {
  const src = read(f);
  if (/\beval\s*\(|new Function\s*\(/.test(src)) bad.push(`${f}: eval`);
  if (/document\.write\s*\(/.test(src)) bad.push(`${f}: document.write`);
  if (/innerHTML\s*=\s*[^`'"]*(location|document\.URL|e\.data|message)/i.test(src)) bad.push(`${f}: innerHTML from outside data`);
  if (/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) bad.push(`${f}: an external address`);
  const syntax = spawnSync(process.execPath, ["--check", path.join(dist, f)], { encoding: "utf8" });
  if (syntax.status !== 0) bad.push(`${f}: syntax error`);
}
check(bad.length === 0, "no eval, no document.write, no external addresses, every script parses", bad.join("; "));
const remote = html.filter((f) => /<script[^>]+src=["']https?:/i.test(read(f)) || /<link[^>]+href=["']https?:/i.test(read(f)));
check(remote.length === 0, "pages load nothing from the internet", remote.join(","));
const inline = html.filter((f) => /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(read(f)));
check(inline.length === 0, "no inline scripts (works under the strict default security policy)", inline.join(","));

check(!/PRIVATE KEY/.test(JSON.stringify(m)) && /^[A-Za-z0-9+/=]+$/.test(m.key) && m.key.length < 600, "only the public key is in the manifest");
check(!fs.readdirSync(SPIKE).some((f) => /\.pem$/i.test(f)), "no private key file next to the code");
check(Object.keys(m.commands ?? {}).length <= 4, "four shortcuts at most (the browser's limit)", Object.keys(m.commands ?? {}).join(","));
const size = fs.readdirSync(dist).reduce((n, f) => n + (fs.statSync(path.join(dist, f)).isFile() ? fs.statSync(path.join(dist, f)).size : 0), 0);
check(size < 400_000, "small enough to install in a moment", `${(size / 1024).toFixed(0)} KB of code`);

fs.rmSync(dist, { recursive: true, force: true });
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
