// Storage port, default implementation: plain files in one folder.
//
// A storage object is anything with this shape (swap it to keep recordings in
// S3, a database, a network share...):
//
//   list():            [{ name, size, time, durationMs }]  newest first
//   pathOf(name):      absolute path of a stored file, or null when `name` is
//                      not a legal stored file name (never trust a client name)
//   remove(name):      delete the file and its metadata
//   newName(prefix, ext, taken?): a unique file name
//   partPath(name):    where a file is written while it is incomplete (never listed)
//   commit(name, meta): promote partPath(name) to the real file, with metadata
//   saveStream(...)    not needed: routes write to partPath() themselves
//
// Anything else (upload to a bucket, notify a service...) belongs in a server
// plugin listening to the "recording:saved" event.

import fs from "node:fs";
import path from "node:path";
import { stamp } from "./util.js";

const NAME_RE = /^[\w.-]+\.(mp4|png)$/;

export class FileStorage {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  isValidName(name) {
    return NAME_RE.test(String(name)) && path.basename(String(name)) === String(name);
  }

  pathOf(name) {
    const n = path.basename(String(name));
    return NAME_RE.test(n) ? path.join(this.dir, n) : null;
  }

  readMeta(name) {
    try {
      return JSON.parse(fs.readFileSync(`${this.pathOf(name)}.json`, "utf8"));
    } catch {
      return {};
    }
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((n) => NAME_RE.test(n))
      .map((n) => {
        const st = fs.statSync(path.join(this.dir, n));
        return { name: n, size: st.size, time: st.mtimeMs, durationMs: this.readMeta(n).durationMs ?? null };
      })
      .sort((a, b) => b.time - a.time);
  }

  remove(name) {
    const file = this.pathOf(name);
    if (!file) return false;
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.json`, { force: true });
    return true;
  }

  exists(name) {
    const file = this.pathOf(name);
    return !!file && fs.existsSync(file);
  }

  /** A name nobody else has (or is about to have): recording-20261116-221530[-2].mp4 */
  newName(prefix, ext, isTaken = () => false) {
    const base = `${prefix}-${stamp()}`;
    for (let n = 1; ; n++) {
      const name = `${base}${n > 1 ? `-${n}` : ""}.${ext}`;
      if (!isTaken(name) && !fs.existsSync(path.join(this.dir, name))) return name;
    }
  }

  partPath(name) {
    return path.join(this.dir, `${name}.part`);
  }

  /** Scratch files (e.g. the WebM of a whole-file upload). Never listed. */
  tempPath(name) {
    return path.join(this.dir, `${name}.tmp`);
  }

  commit(name, meta = {}) {
    const file = this.pathOf(name);
    fs.renameSync(this.partPath(name), file);
    if (Object.keys(meta).length) fs.writeFileSync(`${file}.json`, JSON.stringify(meta));
    return { name, size: fs.statSync(file).size, ...meta };
  }

  discardPart(name) {
    fs.rmSync(this.partPath(name), { force: true });
  }
}
