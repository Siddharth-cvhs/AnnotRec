import { useEffect, useRef } from "react";
import { Slot } from "./Slot";
import { useKernel, useStore } from "./context";

/**
 * The recorded region. This element's box is exactly what ends up in the
 * video: no border, padding or scaling on it. The coloured frame is an outline
 * (outside the box). Features draw inside it through the "stage.layer" slot
 * (the annotation overlay, the countdown...).
 */
export function Viewport() {
  const k = useKernel();
  const viewport = k.services.viewport;
  const { src, reloadKey, sizeMode } = useStore(viewport.store);
  const phase = useStore(k.services.recording.store, (s) => s.phase);
  const frozen = useStore(k.services.annotation.store, (s) => s.frozen !== null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    viewport.element = el;
    const report = () => viewport.setMeasured({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => {
      ro.disconnect();
      if (viewport.element === el) viewport.element = null;
    };
  }, [viewport]);

  const style = sizeMode.kind === "fit" ? { width: "100%", height: "100%" } : { width: sizeMode.w, height: sizeMode.h };
  return (
    <div ref={ref} className="viewport" data-phase={phase} data-frozen={frozen} style={style} data-testid="viewport">
      {src ? (
        <iframe key={reloadKey} className="frame" src={src} title="Recorded page" data-testid="frame" />
      ) : (
        <div className="viewport-loading">Connecting to the server…</div>
      )}
      <Slot name="stage.layer" />
    </div>
  );
}
