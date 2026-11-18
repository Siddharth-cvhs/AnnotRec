// Builds the unpacked extension into dist/ (load that folder with "Load unpacked").
// Adds the fixed extension id (key.json) to the manifest so the id never changes, and writes version.txt:
// a fingerprint of the files, which the extension uses to reload itself when you rebuild (development only).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SRC = path.join(HERE, "src");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "dist");
const { key } = JSON.parse(fs.readFileSync(path.join(HERE, "key.json"), "utf8"));

const files = (dir, base = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));

fs.rmSync(OUT, { recursive: true, force: true });
const hash = crypto.createHash("sha1");
let count = 0;
for (const f of files(SRC)) {
  const data = fs.readFileSync(path.join(SRC, f));
  hash.update(f).update(data);
  fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
  if (f === "manifest.json") {
    const manifest = JSON.parse(data.toString("utf8"));
    fs.writeFileSync(path.join(OUT, f), JSON.stringify({ ...manifest, key }, null, 2));
  } else {
    fs.writeFileSync(path.join(OUT, f), data);
  }
  count++;
}
fs.writeFileSync(path.join(OUT, "version.txt"), hash.digest("hex").slice(0, 12));
console.log(`built ${count + 1} files into ${OUT}`);
