import { Mic, MicOff } from "lucide-react";
import type { Phase } from "../../core/types";
import { MicMeter } from "../../ui/MicMeter";
import { Timer } from "../../ui/Timer";
import { useKernel, useStore } from "../../ui/context";

const LABEL: Record<Phase, string> = {
  idle: "Ready",
  countdown: "Starting…",
  recording: "Recording",
  paused: "Paused",
  saving: "Saving…",
};

/** The status pill in the top bar. */
export function StatusPill() {
  const k = useKernel();
  const { phase, timer } = useStore(k.services.recording.store);
  const active = phase === "recording" || phase === "paused";
  return (
    <div className={`pill ph-${phase}`} data-testid="status-pill" role="status">
      <span className="dot" />
      <span data-testid="phase">{LABEL[phase].toUpperCase()}</span>
      {active && (
        <span data-testid="timer">
          <Timer base={timer.base} since={timer.since} />
        </span>
      )}
    </div>
  );
}

/** The 3-2-1 shown over the viewport before recording starts (it is gone before the first recorded frame). */
export function CountdownLayer() {
  const k = useKernel();
  const countdown = useStore(k.services.recording.store, (s) => s.countdown);
  if (countdown === null) return null;
  return (
    <div className="countdown-overlay" aria-live="assertive" data-testid="countdown">
      <span key={countdown}>{countdown}</span>
      <small>Recording starts… press Esc to cancel</small>
    </div>
  );
}

/** The microphone button with its level meter, in the Record card's button row. */
export function MicButton() {
  const k = useKernel();
  const micOn = useStore(k.services.settings.store, (s) => s.micOn);
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  const rec = phase === "recording" || phase === "paused";
  return (
    <button
      className={`btn mic ${micOn ? "on" : "off"}`}
      onClick={() => void k.run("recording.toggleMic")}
      data-testid="mic"
      title="Microphone (Shift+M)"
      aria-pressed={micOn}
    >
      {micOn ? <Mic size={16} /> : <MicOff size={16} />}
      <span data-testid="mic-label">{micOn ? "Mic on" : "Mic off"}</span>
      <MicMeter level={k.services.recording.level} active={rec && micOn} />
    </button>
  );
}
