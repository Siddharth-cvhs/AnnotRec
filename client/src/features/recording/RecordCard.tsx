import { Circle, Loader2, Pause, Play, Square } from "lucide-react";
import { Slot } from "../../ui/Slot";
import { Timer } from "../../ui/Timer";
import { useKernel, useStore } from "../../ui/context";

const Kbd = ({ children }: { children: string }) => <kbd>{children}</kbd>;

/** The Record card: start / pause / stop, the saving progress and a row other features can add buttons to. */
export function RecordCard() {
  const k = useKernel();
  const { phase, timer, saveProgress } = useStore(k.services.recording.store);
  const sessionActive = useStore(k.services.capture.store, (s) => s.active);
  const ffmpeg = useStore(k.services.backend.store, (s) => s.ffmpeg);
  const supported = k.services.capture.supported;
  const run = (id: string) => () => void k.run(id);

  const rec = phase === "recording" || phase === "paused";
  const pct = Math.round((saveProgress ?? 0) * 100);

  return (
    <section className="card" aria-labelledby="rec-title">
      <h2 id="rec-title">Record</h2>

      {!supported && (
        <div className="notice error" data-testid="unsupported">
          This browser can’t record just a region of the page. Open this app in <b>Microsoft Edge or Chrome</b> (version 104 or
          newer) at <b>http://localhost</b>.
        </div>
      )}
      {!ffmpeg && (
        <div className="notice error" data-testid="no-ffmpeg">
          FFmpeg wasn’t found on the server, so MP4 export will fail. Install FFmpeg (or set <code>FFMPEG_PATH</code>) and
          restart.
        </div>
      )}

      {phase === "saving" ? (
        <div className="saving" data-testid="saving">
          <div className="saving-head">
            <Loader2 size={16} className="spin" />
            <span>Converting to MP4…</span>
            <span className="mono">{pct}%</span>
          </div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${Math.max(4, pct)}%` }} />
          </div>
        </div>
      ) : rec ? (
        <>
          <div className="bigtimer" data-state={phase}>
            <Timer base={timer.base} since={timer.since} />
            <span>{phase === "paused" ? "Paused" : "Recording"}</span>
          </div>
          <div className="btn-row">
            {phase === "paused" ? (
              <button className="btn primary" onClick={run("recording.resume")} data-testid="resume" title="Resume (Space)">
                <Play size={16} /> Resume <Kbd>Space</Kbd>
              </button>
            ) : (
              <button className="btn" onClick={run("recording.pause")} data-testid="pause" title="Pause (Space)">
                <Pause size={16} /> Pause <Kbd>Space</Kbd>
              </button>
            )}
            <button className="btn danger" onClick={run("recording.stop")} data-testid="stop" title="Stop and save (Shift+R)">
              <Square size={14} fill="currentColor" /> Stop <Kbd>⇧R</Kbd>
            </button>
          </div>
        </>
      ) : phase === "countdown" ? (
        <button className="btn wide" onClick={run("recording.cancelCountdown")} data-testid="cancel-countdown">
          Cancel <Kbd>Esc</Kbd>
        </button>
      ) : (
        <button className="btn primary rec wide" disabled={!supported} onClick={run("recording.start")} data-testid="start" title="Start recording (R)">
          <Circle size={14} fill="currentColor" /> Start recording <Kbd>R</Kbd>
        </button>
      )}

      <div className="btn-row">
        <Slot name="record.actions" />
      </div>

      <p className="hint" data-testid="share-hint">
        {sessionActive
          ? "Sharing this tab. Only the viewport is recorded, never this panel."
          : "The first time you record or draw, your browser asks what to share. Choose “This tab”."}
      </p>
    </section>
  );
}
