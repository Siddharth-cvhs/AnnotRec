import { useEffect, useState } from "react";
import { ArrowRight, Maximize2, RotateCw } from "lucide-react";
import type { SizeMode } from "../../core/types";
import { useKernel, useStore } from "../../ui/context";

const PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: "1920", label: "Desktop 1920×1080", w: 1920, h: 1080 },
  { id: "1440", label: "Laptop 1440×900", w: 1440, h: 900 },
  { id: "1280", label: "HD 1280×720", w: 1280, h: 720 },
  { id: "tablet", label: "Tablet 820×1180", w: 820, h: 1180 },
  { id: "mobile", label: "Phone 390×844", w: 390, h: 844 },
];

/** The address field, reload and viewport size picker above the recorded page. */
export function AddressBar() {
  const k = useKernel();
  const viewport = k.services.viewport;
  const { address, sizeMode, measured } = useStore(viewport.store);
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  const locked = phase !== "idle";
  const [value, setValue] = useState(address);
  useEffect(() => setValue(address), [address]);

  const preset = sizeMode.kind === "fit" ? "fit" : (PRESETS.find((p) => p.w === sizeMode.w && p.h === sizeMode.h)?.id ?? "custom");
  const scaled = sizeMode.kind === "fixed" && (measured.w < sizeMode.w - 1 || measured.h < sizeMode.h - 1);

  const choose = (id: string) => {
    const mode: SizeMode | null = id === "fit" ? { kind: "fit" } : (() => {
      const p = PRESETS.find((x) => x.id === id);
      return p ? { kind: "fixed", w: p.w, h: p.h } : null;
    })();
    if (mode) viewport.setSizeMode(mode);
  };

  return (
    <div className="addressbar">
      <form
        className="address"
        onSubmit={(e) => {
          e.preventDefault();
          void viewport.go(value);
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Address of the page to record, e.g. localhost:3000"
          spellCheck={false}
          autoComplete="off"
          aria-label="Page address"
          data-testid="address"
        />
        <button type="submit" className="go" title="Load this page" data-testid="go" disabled={!value.trim()}>
          Go <ArrowRight size={14} />
        </button>
      </form>
      <button className="icon-btn" title="Reload the page" aria-label="Reload" onClick={() => viewport.reload()} data-testid="reload">
        <RotateCw size={16} />
      </button>
      <div className="sizer">
        <select aria-label="Viewport size" value={preset} disabled={locked} data-testid="size-preset" onChange={(e) => choose(e.target.value)}>
          <option value="fit">Fit to window</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {preset === "custom" && <option value="custom">{locked ? "Locked while recording" : "Custom"}</option>}
        </select>
        <span
          className="size-chip mono"
          title={scaled ? "The window is smaller than the chosen size, so it is scaled down to fit." : "Recorded size (CSS pixels)"}
          data-testid="size-chip"
        >
          <Maximize2 size={12} />
          {measured.w} × {measured.h}
          {scaled && " (fit)"}
        </span>
      </div>
    </div>
  );
}
