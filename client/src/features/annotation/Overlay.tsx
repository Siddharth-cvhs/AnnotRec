import { useEffect, useLayoutEffect, useRef } from "react";
import type { Pt } from "../../core/types";
import { useKernel, useStore } from "../../ui/context";
import { textSize } from "./shapes";

/**
 * The drawing layer sitting exactly on the viewport. Live: invisible and
 * click-through. Frozen: shows the picture of the page taken when annotating
 * began, with a canvas on top that takes the mouse. It is only a view: the
 * shapes, tools and painting live in the InkEngine; this component forwards
 * pointer events to it. It has no controls of its own, because everything it
 * shows is part of the recording.
 */
export function Overlay() {
  const k = useKernel();
  const annotation = k.services.annotation;
  const engine = annotation.engine;
  const { frozen, tool } = useStore(annotation.store);
  const textAt = useStore(engine.store, (s) => s.textAt);
  const { color, width } = useStore(k.services.settings.store);
  const canvas = useRef<HTMLCanvasElement>(null);
  const backdrop = useRef<HTMLCanvasElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => engine.attach(canvas.current!), [engine]);

  // Painted in a layout effect: the canvas must hold the picture in the very
  // frame it appears, or a blank flash would be recorded.
  useLayoutEffect(() => {
    const c = backdrop.current;
    if (!c || !frozen) return;
    c.width = frozen.width;
    c.height = frozen.height;
    c.getContext("2d")?.drawImage(frozen, 0, 0);
  }, [frozen]);

  useEffect(() => {
    if (textAt) textBox.current?.focus();
  }, [textAt]);

  const point = (e: { clientX: number; clientY: number }, el: Element): Pt => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (engine.keepsFocus) e.preventDefault(); // keep the new text box focused
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e, e.currentTarget);
    engine.pointerDown(p, { shift: e.shiftKey, samples: [p] });
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const p = point(e, el);
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    engine.pointerMove(p, { shift: e.shiftKey, samples: coalesced.length > 1 ? coalesced.map((s) => point(s, el)) : [p] });
  };

  const onUp = () => engine.pointerUp();

  const isFrozen = frozen !== null;
  return (
    <div className="overlay-root" style={{ pointerEvents: isFrozen ? "auto" : "none" }} data-testid="overlay">
      {frozen && <canvas ref={backdrop} className="overlay-backdrop" aria-hidden="true" />}
      <canvas
        ref={canvas}
        className="overlay-canvas"
        data-testid="overlay-canvas"
        data-tool={tool}
        style={{ cursor: isFrozen ? engine.cursor : "default" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      {textAt && (
        <textarea
          ref={textBox}
          className="overlay-text"
          style={{ left: textAt.x, top: textAt.y, color, fontSize: textSize(width) }}
          rows={1}
          aria-label="Annotation text"
          onKeyDown={(e) => {
            e.stopPropagation(); // typing must not trigger shortcuts
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              engine.commitText(e.currentTarget.value, color, textSize(width));
            } else if (e.key === "Escape") {
              engine.cancelText();
            }
          }}
          onBlur={(e) => engine.commitText(e.currentTarget.value, color, textSize(width))}
        />
      )}
    </div>
  );
}
