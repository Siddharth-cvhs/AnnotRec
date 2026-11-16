import { memo, useEffect, useRef } from "react";

const BARS = 8;

/**
 * Microphone level bars. Drawn straight to the DOM from an animation frame
 * (no React renders), and a bar is only touched when it actually changes:
 * rewriting an unchanged attribute still costs a style recalculation, which
 * at 60 fps x 8 bars is hundreds of pointless DOM writes per second.
 */
export const MicMeter = memo(function MicMeter({ level, active }: { level: () => number; active: boolean }) {
  const bars = useRef<HTMLSpanElement[]>([]);
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const shown: boolean[] = Array(BARS).fill(false);
    const loop = () => {
      const v = active ? level() : 0;
      smooth = v > smooth ? v : smooth * 0.85; // quick attack, slow release
      for (let i = 0; i < BARS; i++) {
        const on = smooth * BARS > i + 0.2;
        if (on !== shown[i]) {
          shown[i] = on;
          const el = bars.current[i];
          if (el) el.dataset.on = on ? "1" : "0";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [level, active]);
  return (
    <span className="meter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} ref={(el) => void (el && (bars.current[i] = el))} data-on="0" />
      ))}
    </span>
  );
});
