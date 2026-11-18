import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, "..", "..", "client");

/**
 * Every option has a default, so `createAnnotRec()` works with no arguments.
 *
 * @typedef {object} AnnotRecOptions
 * @property {string}   [recDir]          where recordings are kept (default ./recordings); ignored when `storage` is given
 * @property {number}   [proxyPort]       port of the viewport proxy (default 4001)
 * @property {string}   [ffmpegPath]      FFmpeg binary (default $FFMPEG_PATH or "ffmpeg"); ignored when `converter` is given
 * @property {object}   [storage]         storage port (see storage.js); default: files in `recDir`
 * @property {object}   [converter]       converter port (see converter.js); default: FFmpeg
 * @property {false|Function} [guard]     request guard: default only this machine; false disables; or your own middleware
 * @property {string[]} [allowedOrigins] extra exact origins that may call the API, e.g. ["chrome-extension://<id>"] (default: $ANNOTREC_ALLOWED_ORIGINS, comma separated)
 * @property {number}   [liveIdleMs]      kill an abandoned live conversion after this long (default 90 s)
 * @property {number}   [maxUploadBytes]  largest accepted upload (default 4 GB)
 * @property {string}   [samplePage]      the page shown until an address is chosen
 * @property {Function[]} [plugins]       server plugins: `(ctx) => void`, see annotrec.js
 */
export function normalizeOptions(o = {}) {
  return {
    recDir: path.resolve(o.recDir ?? process.env.REC_DIR ?? "recordings"),
    proxyPort: o.proxyPort ?? (Number(process.env.PROXY_PORT) || 4001),
    ffmpegPath: o.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    storage: o.storage ?? null,
    converter: o.converter ?? null,
    guard: o.guard === undefined ? "loopback" : o.guard,
    allowedOrigins: o.allowedOrigins ?? (process.env.ANNOTREC_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    liveIdleMs: o.liveIdleMs ?? 90_000,
    maxUploadBytes: o.maxUploadBytes ?? 4 * 1024 ** 3,
    samplePage:
      o.samplePage ?? [path.join(CLIENT, "dist", "sample.html"), path.join(CLIENT, "public", "sample.html")].find((f) => fs.existsSync(f)),
    plugins: o.plugins ?? [],
  };
}
