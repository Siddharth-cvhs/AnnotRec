// Builds the unpacked extension into dist/ (load that folder with "Load unpacked").
// Adds the fixed extension id (key.json) to the manifest so the id never changes.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const SRC = path.join(HERE, "src");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "dist");
const { key } = JSON.parse(fs.readFileSync(path.join(HERE, "key.json"), "utf8"));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  if (f === "manifest.json") continue;
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ ...manifest, key }, null, 2));
console.log(`built ${fs.readdirSync(OUT).length} files into ${OUT}`);
