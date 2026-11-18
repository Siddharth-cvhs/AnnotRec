import fs from "node:fs";

// Live conversion sessions.
//
// While the browser records, it sends the WebM in pieces and the converter
// encodes them as they arrive, so "Stop" only has to finish the last piece.
// The browser keeps every piece and falls back to a whole-file upload if
// anything here fails, so this path may fail loudly and cleanly.

export class LiveSessions {
  /**
   * @param {{ storage, converter, events, idleMs: number }} deps
   */
  constructor({ storage, converter, events, idleMs }) {
    this.storage = storage;
    this.converter = converter;
    this.events = events;
    this.idleMs = idleMs;
    this.sessions = new Map(); // name -> session
    // A vanished browser must not leave an encoder running.
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  open(quality, { videoCopy = false } = {}) {
    const name = this.storage.newName("recording", "mp4", (n) => this.sessions.has(n));
    const abort = new AbortController();
    const s = { name, abort, lastSeen: Date.now(), ended: false, onProgress: null };
    const conv = this.converter.start(null, this.storage.partPath(name), {
      quality,
      videoCopy,
      signal: abort.signal,
      onProgress: (ms) => s.onProgress?.(ms),
    });
    s.conv = conv;
    s.promise = conv.promise;
    s.promise.catch(() => {}); // reported by finish()
    this.sessions.set(name, s);
    return name;
  }

  get(name) {
    const s = this.sessions.get(name);
    return s && !s.ended ? s : null;
  }

  /** Append one piece (an async iterable of Buffers) to the session's encoder. */
  async append(s, source) {
    s.lastSeen = Date.now();
    for await (const chunk of source) {
      await new Promise((resolve, reject) => {
        const stdin = s.conv.stdin;
        if (!stdin?.writable) return reject(new Error("The converter is not running."));
        stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  /** Close the input and wait for the MP4. Resolves with the committed file info. */
  async finish(s, { onProgress }) {
    s.ended = true;
    s.onProgress = onProgress;
    try {
      s.conv.stdin.end();
      const durationMs = await s.promise;
      const part = this.storage.partPath(s.name);
      if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new Error("The recording was empty.");
      const saved = this.storage.commit(s.name, { durationMs: Math.round(durationMs) });
      this.sessions.delete(s.name);
      return saved;
    } catch (e) {
      this.drop(s);
      throw e;
    }
  }

  abort(name) {
    const s = this.sessions.get(name);
    if (!s) return;
    s.abort.abort();
    this.drop(s);
  }

  drop(s) {
    this.sessions.delete(s.name);
    this.storage.discardPart(s.name);
  }

  sweep() {
    for (const s of this.sessions.values()) {
      if (!s.ended && Date.now() - s.lastSeen > this.idleMs) {
        s.abort.abort();
        this.drop(s);
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.conv.kill();
    this.sessions.clear();
  }
}
