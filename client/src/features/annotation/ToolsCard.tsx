import { Redo2, Trash2, Undo2, XCircle } from "lucide-react";
import { useKernel, useRegistry, useStore } from "../../ui/context";

const COLORS = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111111"];

/** The Annotate card. The tool buttons come straight from the `tools` registry. */
export function ToolsCard() {
  const k = useKernel();
  const tools = useRegistry(k.tools);
  const { frozen, tool } = useStore(k.services.annotation.store);
  const ink = useStore(k.services.annotation.engine.store, (s) => s.ink);
  const { color, width } = useStore(k.services.settings.store);
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  const settings = k.services.settings;
  const isFrozen = frozen !== null;
  const disabled = !k.services.capture.supported || phase === "saving" || phase === "countdown";
  const run = (id: string, args?: unknown) => () => void k.run(id, args);

  return (
    <section className="card" aria-labelledby="tools-title">
      <h2 id="tools-title">
        Annotate
        {isFrozen && (
          <span className="badge" data-testid="frozen-badge">
            Page frozen
          </span>
        )}
      </h2>

      <div className="tools" role="toolbar" aria-label="Annotation tools" data-testid="tools" data-ink={ink.count}>
        {tools.map((t) => {
          const Icon = t.icon;
          const active = tool === t.id || (t.id === "live" && !isFrozen);
          const hint = t.hint ?? t.key?.toUpperCase();
          return (
            <button
              key={t.id}
              className={`tool ${active ? "active" : ""}`}
              title={hint ? `${t.label} (${hint})` : t.label}
              aria-label={t.label}
              aria-pressed={active}
              data-testid={`tool-${t.id}`}
              disabled={disabled}
              onClick={run("annotation.pickTool", { id: t.id })}
            >
              <Icon size={18} />
              <span>{t.short ?? t.label.split(" ")[0]}</span>
            </button>
          );
        })}
      </div>

      <div className="colors" role="group" aria-label="Colour">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${color.toLowerCase() === c ? "active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`Colour ${c}`}
            data-testid={`color-${c.slice(1)}`}
            onClick={() => settings.patch({ color: c })}
          />
        ))}
        <label className="swatch custom" title="Custom colour">
          <input type="color" value={color} aria-label="Custom colour" onChange={(e) => settings.patch({ color: e.target.value })} />
        </label>
      </div>

      <div className="slider">
        <span>Size</span>
        <input
          type="range"
          min={2}
          max={16}
          value={width}
          aria-label="Stroke size"
          data-testid="width"
          onChange={(e) => settings.patch({ width: Number(e.target.value) })}
        />
        <span className="preview" aria-hidden="true">
          <i style={{ width: width + 2, height: width + 2, background: color }} />
        </span>
      </div>

      <div className="btn-row">
        <button className="btn sm" disabled={!ink.canUndo} onClick={run("annotation.undo")} data-testid="undo" title="Undo (Ctrl+Z)">
          <Undo2 size={15} /> Undo
        </button>
        <button className="btn sm" disabled={!ink.canRedo} onClick={run("annotation.redo")} data-testid="redo" title="Redo (Ctrl+Y)">
          <Redo2 size={15} /> Redo
        </button>
        <button className="btn sm" disabled={!ink.selected} onClick={run("annotation.deleteSelected")} data-testid="delete" title="Delete the selected shape (Del)">
          <XCircle size={15} /> Delete
        </button>
      </div>
      <button className="btn danger wide" disabled={!isFrozen} onClick={run("annotation.goLive")} data-testid="clear" title="Remove all drawings and go back to the live page (Esc)">
        <Trash2 size={15} /> Clear all and go live
      </button>
    </section>
  );
}
