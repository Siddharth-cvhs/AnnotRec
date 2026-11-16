import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { OverlayCmd, Tool } from "./ipc";
import {
  drawShape,
  History,
  isFreehand,
  isTwoPoint,
  newId,
  textSize,
  type DrawKind,
  type Pt,
  type Shape,
} from "./drawing";

// The overlay window sits exactly on the viewport. Live: fully transparent
// and click-through (Rust sets that). Annotating: shows the frozen picture of
// the page and a canvas on top. It has no controls of its own, because
// everything it shows is burned into the recording.

const DRAW_KINDS: DrawKind[] = ["pen", "pencil", "highlighter", "line", "arrow", "rect", "ellipse"];

interface TextDraft {
  x: number;
  y: number;
}

export function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const history = useRef(new History());
  const draft = useRef<Shape | null>(null);
  const tool = useRef<Tool>("pen");
  const color = useRef("#ef4444");
  const width = useRef(4);
  const erasing = useRef(false);
  const eraseStarted = useRef(false);
  const [image, setImage] = useState<string | null>(null);
  const [textAt, setTextAt] = useState<TextDraft | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of history.current.shapes) drawShape(ctx, s);
    if (draft.current) drawShape(ctx, draft.current);
  }, []);

  // The text box's position, mirrored in a ref so a commit (which runs from
  // blur and key events) never depends on a state updater's timing.
  const textAtRef = useRef<TextDraft | null>(null);
  const openText = (at: TextDraft | null) => {
    textAtRef.current = at;
    setTextAt(at);
  };

  const commitText = useCallback(
    (value: string) => {
      const at = textAtRef.current;
      textAtRef.current = null;
      setTextAt(null);
      if (at && value.trim()) {
        history.current.add({
          id: newId(),
          kind: "text",
          p: { x: at.x, y: at.y },
          text: value,
          color: color.current,
          size: textSize(width.current),
        });
        render();
      }
    },
    [render],
  );

  // Events from the toolbar (through the Rust side).
  useEffect(() => {
    const unlisten = Promise.all([
      listen<{ image: string }>("freeze", (e) => setImage(e.payload.image)),
      listen("clear-all", () => {
        history.current.reset();
        draft.current = null;
        erasing.current = false;
        textAtRef.current = null;
        setTextAt(null);
        setImage(null);
        render();
      }),
      listen<OverlayCmd>("overlay-cmd", (e) => {
        const cmd = e.payload;
        switch (cmd.type) {
          case "tool":
            tool.current = cmd.tool;
            if (cmd.tool !== "text") {
              textAtRef.current = null;
              setTextAt(null);
            }
            break;
          case "color":
            color.current = cmd.color;
            break;
          case "width":
            width.current = cmd.width;
            break;
          case "undo":
            history.current.undo();
            break;
          case "redo":
            history.current.redo();
            break;
        }
        render();
      }),
    ]);
    const onResize = () => render();
    window.addEventListener("resize", onResize);
    render();
    return () => {
      window.removeEventListener("resize", onResize);
      void unlisten.then((fns) => fns.forEach((f) => f()));
    };
  }, [render]);

  useEffect(() => {
    if (textAt) textRef.current?.focus();
  }, [textAt]);

  const point = (e: React.PointerEvent): Pt => ({ x: e.clientX, y: e.clientY });

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = point(e);
    const t = tool.current;
    if (t === "text") {
      e.preventDefault(); // keep the new box focused, not the canvas
      if (textAtRef.current) return; // a click away commits it via blur
      openText({ x: p.x, y: p.y });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (t === "eraser") {
      erasing.current = true;
      eraseStarted.current = false;
      if (history.current.eraseAt(p, true)) eraseStarted.current = true;
      render();
      return;
    }
    if (!DRAW_KINDS.includes(t as DrawKind)) return;
    const kind = t as DrawKind;
    const base = { id: newId(), color: color.current, width: width.current };
    draft.current =
      kind === "pen" || kind === "pencil" || kind === "highlighter"
        ? { ...base, kind, pts: [p] }
        : { ...base, kind, a: p, b: p };
    render();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = point(e);
    if (erasing.current) {
      if (history.current.eraseAt(p, !eraseStarted.current)) eraseStarted.current = true;
      render();
      return;
    }
    const d = draft.current;
    if (!d) return;
    if (isFreehand(d)) {
      d.pts.push(p);
    } else if (isTwoPoint(d)) {
      d.b = p;
    }
    render();
  };

  const onUp = () => {
    erasing.current = false;
    const d = draft.current;
    draft.current = null;
    if (d) {
      const tiny = isTwoPoint(d) && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < 3;
      if (!tiny) history.current.add(d);
    }
    render();
  };

  const frozen = image !== null;
  return (
    <div className="overlay-root">
      {image && <img className="overlay-backdrop" src={image} alt="" draggable={false} />}
      <canvas
        ref={canvasRef}
        className="overlay-canvas"
        style={{ cursor: frozen ? (tool.current === "text" ? "text" : "crosshair") : "default" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      {textAt && (
        <textarea
          ref={textRef}
          className="overlay-text"
          style={{
            left: textAt.x,
            top: textAt.y,
            color: color.current,
            fontSize: textSize(width.current),
          }}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText(e.currentTarget.value);
            } else if (e.key === "Escape") {
              textAtRef.current = null;
              setTextAt(null);
            }
          }}
          onBlur={(e) => commitText(e.currentTarget.value)}
        />
      )}
    </div>
  );
}
