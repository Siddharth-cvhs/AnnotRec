// HTTP adapters: the AnnotRec server behind the LibraryPort, ViewportPort,
// BackendPort and a RecordingSink. `apiBase` is where the server's router is
// mounted ("" when it is at the site root, "/tools/annotrec" when embedded).

import type { BackendPort, LibraryPort, RecordingSink, SinkSession, ViewportPort } from "../core/ports";
import type { FileInfo, Quality, Saved } from "../core/types";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Reads the server's JSON-lines reply: progress while it converts, then the saved file or an error. */
async function readSaved(res: Response, onProgress: (fraction: number) => void): Promise<Saved> {
  if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Saved | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { progress?: number; done?: Saved; error?: string };
      if (msg.error) throw new Error(msg.error);
      if (msg.progress !== undefined) onProgress(msg.progress);
      if (msg.done) result = msg.done;
    }
    if (done) break;
  }
  if (!result) throw new Error("The server stopped before the MP4 was ready.");
  return result;
}

export class HttpLibrary implements LibraryPort {
  constructor(private readonly base: string) {}

  list = () => fetch(`${this.base}/api/recordings`).then((r) => json<FileInfo[]>(r));

  async remove(name: string) {
    await fetch(`${this.base}/api/recordings/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async reveal(name: string) {
    const r = await fetch(`${this.base}/api/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Cannot open the folder");
  }

  url = (name: string, download = false) => `${this.base}/api/recordings/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;

  saveImage = (blob: Blob) =>
    fetch(`${this.base}/api/screenshots`, { method: "POST", body: blob }).then((r) => json<{ name: string; size: number }>(r));
}

export class HttpViewport implements ViewportPort {
  constructor(private readonly base: string) {}

  setTarget = (address: string) =>
    fetch(`${this.base}/api/target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: address }),
    }).then((r) => json<{ viewportUrl: string }>(r));

  sampleUrl = () => `${location.origin}${this.base}/sample.html`;
}

export class HttpBackend implements BackendPort {
  constructor(private readonly base: string) {}

  health = () => fetch(`${this.base}/api/health`).then((r) => json<{ ffmpeg: boolean; qualities: string[] }>(r));
}

/**
 * The server sink. While recording, the WebM goes to the server in pieces and
 * is converted as it arrives, so Stop only waits for the last piece. Any
 * failure on that path just marks it failed; `finish` then uploads the whole
 * recording the ordinary way.
 */
export function createServerSink(base: string): RecordingSink {
  return {
    id: "server",
    label: "AnnotRec server (MP4)",
    order: 0,
    async open({ quality }): Promise<SinkSession> {
      const live = await LiveUpload.open(base, quality);
      return {
        push: (piece) => live?.push(piece),
        async finish(whole, { durationMs, quality: q, onProgress }) {
          const viaLive = live ? await live.finish(durationMs, onProgress) : null;
          if (viaLive) return viaLive;
          onProgress(0);
          const res = await fetch(`${base}/api/recordings?quality=${q}&durationMs=${Math.round(durationMs)}`, {
            method: "POST",
            body: whole,
          });
          return readSaved(res, onProgress);
        },
        abort: () => live?.abort(),
      };
    },
  };
}

class LiveUpload {
  private failed = false;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly base: string,
    private readonly id: string,
  ) {}

  static async open(base: string, quality: Quality): Promise<LiveUpload | null> {
    try {
      const r = await fetch(`${base}/api/live?quality=${quality}`, { method: "POST" });
      return r.ok ? new LiveUpload(base, ((await r.json()) as { id: string }).id) : null;
    } catch {
      return null;
    }
  }

  /** Queues a piece; pieces go out strictly in order. */
  push(blob: Blob) {
    this.chain = this.chain
      .then(async () => {
        if (this.failed) return;
        const r = await fetch(`${this.base}/api/live/${this.id}/chunk`, { method: "POST", body: blob });
        if (!r.ok) throw new Error(`chunk ${r.status}`);
      })
      .catch(() => {
        this.failed = true;
      });
  }

  /** Waits for the last piece, then for the MP4. Null when the live path failed. */
  async finish(durationMs: number, onProgress: (fraction: number) => void): Promise<Saved | null> {
    await this.chain;
    if (this.failed) {
      this.abort();
      return null;
    }
    try {
      const res = await fetch(`${this.base}/api/live/${this.id}/finish?durationMs=${Math.round(durationMs)}`, { method: "POST" });
      return await readSaved(res, onProgress);
    } catch {
      return null;
    }
  }

  abort() {
    void fetch(`${this.base}/api/live/${this.id}`, { method: "DELETE" }).catch(() => {});
  }
}
