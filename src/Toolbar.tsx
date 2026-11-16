import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Camera,
  Circle,
  Eraser,
  FolderOpen,
  Highlighter,
  Mic,
  MicOff,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pause,
  Pen,
  Pencil,
  Play,
  Redo2,
  RotateCw,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { api, type AppState, type Tool } from "./ipc";

const TOOLS: { id: Tool; label: string; icon: typeof Pen }[] = [
  { id: "live", label: "Live (use the page)", icon: MousePointer2 },
  { id: "pen", label: "Pen", icon: Pen },
  { id: "pencil", label: "Pencil", icon: Pencil },
  { id: "highlighter", label: "Highlighter", icon: Highlighter },
  { id: "line", label: "Line", icon: Minus },
  { id: "arrow", label: "Arrow", icon: MoveUpRight },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Circle", icon: Circle },
  { id: "text", label: "Text", icon: Type },
  { id: "eraser", label: "Eraser", icon: Eraser },
];

const COLORS = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111111"];

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function Toolbar() {
  const [state, setState] = useState<AppState | null>(null);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("live");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [url, setUrl] = useState("");
  const [size, setSize] = useState({ w: "", h: "" });
  const editing = useRef(false);

  const apply = useCallback((s: AppState) => {
    setState(s);
    setReceivedAt(Date.now());
    if (!s.annotating) setTool("live");
    if (!editing.current) {
      setUrl((u) => (u === "" || u !== s.url ? (s.url === "sample.html" ? "" : s.url) : u));
      setSize({ w: String(s.viewport[0]), h: String(s.viewport[1]) });
    }
  }, []);

  useEffect(() => {
    void api.getState().then(apply);
    const un = listen<AppState>("state", (e) => apply(e.payload));
    const timer = window.setInterval(() => tick((n) => n + 1), 250);
    return () => {
      window.clearInterval(timer);
      void un.then((f) => f());
    };
  }, [apply]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!state) return <div className="toolbar" />;

  const rec = state.phase === "recording" || state.phase === "paused";
  const busy = state.phase === "stopping";
  const elapsed = state.elapsedMs + (state.phase === "recording" ? Date.now() - receivedAt : 0);

  const pickTool = (t: Tool) => {
    setTool(t);
    void run(() => api.setTool(t));
  };

  return (
    <div className="toolbar">
      <header className="status">
        <span className={`dot ${state.phase}`} />
        <span className="phase">
          {state.phase === "recording" && "RECORDING"}
          {state.phase === "paused" && "PAUSED"}
          {state.phase === "idle" && "READY"}
          {state.phase === "stopping" && "SAVING…"}
        </span>
        <span className="timer">{clock(elapsed)}</span>
        <span className={`mic-state ${state.micOn ? "on" : "off"}`}>
          {state.micOn ? <Mic size={14} /> : <MicOff size={14} />}
          {state.micOn ? "MIC ON" : "MIC OFF"}
        </span>
      </header>
      {state.annotating && <div className="banner">Page frozen for annotation. Recording continues.</div>}

      <section>
        <div className="row">
          <input
            className="grow"
            placeholder="localhost:3000 or any URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={() => (editing.current = true)}
            onBlur={() => (editing.current = false)}
            onKeyDown={(e) => e.key === "Enter" && void run(() => api.navigate(url))}
          />
          <button onClick={() => void run(() => api.navigate(url))}>Go</button>
          <button title="Reload" onClick={() => void run(api.reload)}>
            <RotateCw size={16} />
          </button>
        </div>
        <div className="row small">
          <span>Viewport</span>
          <input
            className="num"
            value={size.w}
            disabled={rec || busy}
            onFocus={() => (editing.current = true)}
            onBlur={() => (editing.current = false)}
            onChange={(e) => setSize({ ...size, w: e.target.value })}
          />
          <span>×</span>
          <input
            className="num"
            value={size.h}
            disabled={rec || busy}
            onFocus={() => (editing.current = true)}
            onBlur={() => (editing.current = false)}
            onChange={(e) => setSize({ ...size, h: e.target.value })}
          />
          <button disabled={rec || busy} onClick={() => void run(() => api.setViewport(Number(size.w), Number(size.h)))}>
            Apply
          </button>
        </div>
      </section>

      <section>
        <div className="row">
          {!rec ? (
            <button className="primary rec" disabled={busy} onClick={() => void run(api.start)}>
              <Circle size={16} fill="currentColor" /> Start
            </button>
          ) : state.phase === "paused" ? (
            <button className="primary" onClick={() => void run(api.resume)}>
              <Play size={16} /> Resume
            </button>
          ) : (
            <button onClick={() => void run(api.pause)}>
              <Pause size={16} /> Pause
            </button>
          )}
          <button disabled={!rec || busy} onClick={() => void run(api.stop)}>
            <Square size={16} fill="currentColor" /> Stop
          </button>
          <button title="Screenshot of the viewport" disabled={busy} onClick={() => void run(api.screenshot)}>
            <Camera size={16} />
          </button>
          <button
            title={state.micOn ? "Mute microphone" : "Unmute microphone"}
            className={state.micOn ? "" : "off"}
            onClick={() => void run(() => api.setMic(!state.micOn))}
          >
            {state.micOn ? <Mic size={16} /> : <MicOff size={16} />}
          </button>
        </div>
        {state.micName && <div className="hint">Microphone: {state.micName}</div>}
      </section>

      <section>
        <div className="tools">
          {TOOLS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              title={label}
              className={tool === id ? "active" : ""}
              disabled={busy}
              onClick={() => pickTool(id)}
            >
              <Icon size={18} />
            </button>
          ))}
        </div>
        <div className="colors">
          {COLORS.map((c) => (
            <button
              key={c}
              title={c}
              className={`swatch ${color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => {
                setColor(c);
                void run(() => api.overlayCmd({ type: "color", color: c }));
              }}
            />
          ))}
        </div>
        <div className="row small">
          <span>Size</span>
          <input
            className="grow"
            type="range"
            min={2}
            max={16}
            value={width}
            onChange={(e) => {
              const w = Number(e.target.value);
              setWidth(w);
              void run(() => api.overlayCmd({ type: "width", width: w }));
            }}
          />
          <span className="num-label">{width}</span>
        </div>
        <div className="row">
          <button disabled={!state.annotating} onClick={() => void run(() => api.overlayCmd({ type: "undo" }))}>
            <Undo2 size={16} /> Undo
          </button>
          <button disabled={!state.annotating} onClick={() => void run(() => api.overlayCmd({ type: "redo" }))}>
            <Redo2 size={16} /> Redo
          </button>
          <button className="danger" disabled={!state.annotating} onClick={() => void run(api.clearAll)}>
            <Trash2 size={16} /> Clear all
          </button>
        </div>
      </section>

      <footer>
        {error && <div className="error">{error}</div>}
        {!error && state.message && <div className="hint">{state.message}</div>}
        {state.lastFile && (
          <div className="saved">
            <div className="path">{state.lastFile}</div>
            <button onClick={() => void run(api.openFolder)}>
              <FolderOpen size={16} /> Show in folder
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
