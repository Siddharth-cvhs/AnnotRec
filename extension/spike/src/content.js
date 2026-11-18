// AnnotRec content script: runs in every page and draws the annotation layer on it.
//
//  - It reports the page's size to the extension (the recorder needs it to crop the window picture).
//  - On "freeze" it paints a picture of the page over the page and lets you draw on it.
//  - On "marker" it briefly draws a magenta frame at the page edges so the recorder can measure
//    exactly where the page sits inside the captured browser window (self-calibrating crop).
//
// Everything lives in a closed Shadow DOM in the browser's top layer (above even a fullscreen video),
// so the page's own CSS cannot touch it.

(() => {
  if (window.__annotrecContent) return;
  window.__annotrecContent = true;

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  const geometry = () => ({ innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio });
  const report = () => send({ type: "geometry", ...geometry() });

  addEventListener("resize", report);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && report());
  report();

  // ------------------------------------------------------------------ UI
  let host, root, bg, cv, ctx, mk;
  let frozen = false;
  let tool = "pen";
  let color = "#a855f7";
  let width = 4;
  let shapes = [];
  let draft = null;

  function ensureUi() {
    if (host) return;
    host = document.createElement("div");
    host.id = "annotrec-host";
    host.setAttribute("popover", "manual"); // the top layer: above everything, fullscreen video included
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;margin:0;padding:0;border:0;" +
      "background:transparent;overflow:visible;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      img,canvas,#mk{position:fixed;left:0;top:0;width:100vw;height:100vh;display:none}
      .ed{position:fixed;min-width:40px;min-height:1.25em;outline:2px dashed rgba(91,140,255,.9);outline-offset:3px;white-space:pre;pointer-events:auto;background:rgba(255,255,255,.04)}
      canvas{pointer-events:none;touch-action:none}
      #mk{border:8px solid rgb(255,0,255);box-sizing:border-box;pointer-events:none}
    </style><img id="bg" alt=""><canvas id="cv"></canvas><div id="mk"></div>`;
    bg = root.getElementById("bg");
    cv = root.getElementById("cv");
    mk = root.getElementById("mk");
    ctx = cv.getContext("2d");
    (document.body ?? document.documentElement).appendChild(host);
    try {
      host.showPopover();
    } catch {
      /* older browsers: the high z-index still works */
    }
    cv.addEventListener("mousedown", (e) => e.preventDefault()); // a click must not steal focus from the text box
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    addEventListener("keydown", onKey, true);
    addEventListener("resize", () => frozen && resizeCanvas());
  }

  function resizeCanvas() {
    const dpr = devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    paint();
  }

  // ---------------------------------------------------------------- drawing
  const TOOLS = ["select", "pen", "highlighter", "line", "arrow", "rect", "ellipse", "text", "marker", "eraser"];
  const KEYS = { v: "select", b: "pen", h: "highlighter", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text", m: "marker", e: "eraser" };
  let redoStack = [];
  let editor = null; // the open text box, if any
  let selected = null; // the shape picked by the select tool
  let dragFrom = null; // pointer position while moving it

  const fontSize = (w) => 14 + w * 3;
  const markerR = (w) => 10 + w * 2;

  /** A freehand line as smooth curves through the midpoints of the recorded points (no visible corners). */
  function smoothPath(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) return ctx.lineTo(pts[0].x + 0.01, pts[0].y);
    if (pts.length === 2) return ctx.lineTo(pts[1].x, pts[1].y);
    for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  function draw(s, index) {
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    switch (s.kind) {
      case "pen":
        smoothPath(s.pts);
        ctx.stroke();
        break;
      case "highlighter":
        ctx.globalAlpha = 0.35;
        ctx.lineCap = "butt";
        ctx.lineWidth = s.width * 4;
        smoothPath(s.pts);
        ctx.stroke();
        break;
      case "line":
      case "arrow": {
        ctx.beginPath();
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.b.x, s.b.y);
        ctx.stroke();
        if (s.kind === "arrow") {
          const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
          const head = Math.max(14, s.width * 4);
          ctx.beginPath();
          ctx.moveTo(s.b.x, s.b.y);
          ctx.lineTo(s.b.x - head * Math.cos(ang - 0.45), s.b.y - head * Math.sin(ang - 0.45));
          ctx.lineTo(s.b.x - head * Math.cos(ang + 0.45), s.b.y - head * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case "rect":
        ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2, Math.abs(s.b.y - s.a.y) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "text": {
        const size = fontSize(s.width);
        ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
        ctx.textBaseline = "top";
        s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.a.x, s.a.y + i * size * 1.25));
        break;
      }
      case "marker": {
        const r = markerR(s.width);
        ctx.beginPath();
        ctx.arc(s.a.x, s.a.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${r * 1.1}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(index), s.a.x, s.a.y + 1);
        break;
      }
    }
    ctx.restore();
  }

  function bounds(s) {
    const pad = Math.max(6, s.width) + 4;
    let x1, y1, x2, y2;
    if (s.pts) {
      x1 = Math.min(...s.pts.map((p) => p.x)); x2 = Math.max(...s.pts.map((p) => p.x));
      y1 = Math.min(...s.pts.map((p) => p.y)); y2 = Math.max(...s.pts.map((p) => p.y));
    } else if (s.kind === "text") {
      const size = fontSize(s.width), lines = s.text.split("\n");
      x1 = s.a.x; y1 = s.a.y; x2 = s.a.x + Math.max(...lines.map((l) => l.length)) * size * 0.6; y2 = s.a.y + lines.length * size * 1.25;
    } else if (s.kind === "marker") {
      const r = markerR(s.width);
      x1 = s.a.x - r; x2 = s.a.x + r; y1 = s.a.y - r; y2 = s.a.y + r;
    } else {
      x1 = Math.min(s.a.x, s.b.x); x2 = Math.max(s.a.x, s.b.x); y1 = Math.min(s.a.y, s.b.y); y2 = Math.max(s.a.y, s.b.y);
    }
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }
  function shift(s, dx, dy) {
    if (s.pts) s.pts.forEach((p) => ((p.x += dx), (p.y += dy)));
    else for (const k of ["a", "b"]) if (s[k]) ((s[k].x += dx), (s[k].y += dy));
  }
  function deleteSelected() {
    const i = shapes.indexOf(selected);
    if (i >= 0) shapes.splice(i, 1);
    selected = null;
    paint();
  }

  // Finished shapes live on a cached picture (`baseCv`); every frame only draws that picture plus the
  // shape being drawn or moved. Painting is batched to one per animation frame.
  let baseCv = null, baseCtx = null, baseDirty = true, baseSkip = null, raf = 0, markerBefore = new Map();

  function rebuildBase() {
    const dpr = devicePixelRatio || 1;
    if (!baseCv) {
      baseCv = document.createElement("canvas");
      baseCtx = baseCv.getContext("2d");
    }
    if (baseCv.width !== cv.width || baseCv.height !== cv.height) {
      baseCv.width = cv.width;
      baseCv.height = cv.height;
    }
    const live = ctx;
    ctx = baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, baseCv.width, baseCv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let n = 0;
    markerBefore = new Map();
    for (const s of shapes) {
      if (s.kind === "marker") markerBefore.set(s, ++n);
      if (s !== baseSkip) draw(s, markerBefore.get(s) ?? 0);
    }
    ctx = live;
    baseDirty = false;
  }

  function render() {
    raf = 0;
    if (!ctx || !cv) return;
    const dpr = devicePixelRatio || 1;
    if (baseDirty) rebuildBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(baseCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (baseSkip && shapes.includes(baseSkip)) draw(baseSkip, markerBefore.get(baseSkip) ?? 0);
    if (draft) draw(draft, markerBefore.size + 1);
    if (selected && shapes.includes(selected)) {
      const b = bounds(selected);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#5b8cff";
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.restore();
    }
  }

  /** Ask for a repaint. `draftOnly`: only the shape being drawn or moved changed (the cheap, frequent case). */
  function paint(draftOnly = false) {
    if (!draftOnly) baseDirty = true;
    if (!raf) raf = requestAnimationFrame(render);
  }

  // Distance helpers for the eraser.
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  function hit(s, p) {
    const tol = Math.max(8, s.width) + 4;
    switch (s.kind) {
      case "pen":
      case "highlighter": {
        const t = s.kind === "highlighter" ? s.width * 2 + 4 : tol;
        return s.pts.some((q, i) => (i ? segDist(p, s.pts[i - 1], q) : Math.hypot(p.x - q.x, p.y - q.y)) <= t);
      }
      case "line":
      case "arrow":
        return segDist(p, s.a, s.b) <= tol;
      case "rect": {
        const x1 = Math.min(s.a.x, s.b.x), x2 = Math.max(s.a.x, s.b.x), y1 = Math.min(s.a.y, s.b.y), y2 = Math.max(s.a.y, s.b.y);
        return (
          segDist(p, { x: x1, y: y1 }, { x: x2, y: y1 }) <= tol || segDist(p, { x: x2, y: y1 }, { x: x2, y: y2 }) <= tol ||
          segDist(p, { x: x2, y: y2 }, { x: x1, y: y2 }) <= tol || segDist(p, { x: x1, y: y2 }, { x: x1, y: y1 }) <= tol
        );
      }
      case "ellipse": {
        const rx = Math.abs(s.b.x - s.a.x) / 2 || 1, ry = Math.abs(s.b.y - s.a.y) / 2 || 1;
        const d = Math.hypot((p.x - (s.a.x + s.b.x) / 2) / rx, (p.y - (s.a.y + s.b.y) / 2) / ry);
        return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
      }
      case "text": {
        const size = fontSize(s.width);
        const lines = s.text.split("\n");
        const w = Math.max(...lines.map((l) => l.length)) * size * 0.6;
        return p.x >= s.a.x - 4 && p.x <= s.a.x + w + 4 && p.y >= s.a.y - 4 && p.y <= s.a.y + lines.length * size * 1.25 + 4;
      }
      case "marker":
        return Math.hypot(p.x - s.a.x, p.y - s.a.y) <= markerR(s.width) + 4;
    }
    return false;
  }

  const pt = (e) => ({ x: e.clientX, y: e.clientY });
  const commit = (s) => {
    shapes.push(s);
    redoStack = [];
  };

  function down(e) {
    if (e.button !== 0) return;
    if (editor) closeEditor(true);
    const p = pt(e);
    if (tool === "select") {
      selected = [...shapes].reverse().find((s) => hit(s, p)) ?? null;
      baseSkip = selected;
      if (selected) {
        cv.setPointerCapture(e.pointerId);
        dragFrom = p;
        cv.style.cursor = "move";
      }
      return paint();
    }
    if (tool === "eraser") {
      cv.setPointerCapture(e.pointerId);
      draft = { kind: "eraser" };
      eraseAt(p);
      return;
    }
    if (tool === "text") return openEditor(p);
    if (tool === "marker") {
      commit({ kind: "marker", color, width, a: p });
      return paint();
    }
    cv.setPointerCapture(e.pointerId);
    draft = tool === "pen" || tool === "highlighter" ? { kind: tool, color, width, pts: [p] } : { kind: tool, color, width, a: p, b: p };
    paint(true);
  }

  function move(e) {
    if (dragFrom && selected) {
      const p = pt(e);
      shift(selected, p.x - dragFrom.x, p.y - dragFrom.y);
      dragFrom = p;
      return paint(true);
    }
    if (!draft) return;
    if (draft.kind === "eraser") return eraseAt(pt(e));
    if (draft.pts) {
      // every point the pointer passed through since the last frame, dropping near-duplicates
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const q = pt(ev), last = draft.pts[draft.pts.length - 1];
        if (Math.hypot(q.x - last.x, q.y - last.y) >= 1.5) draft.pts.push(q);
      }
    } else {
      draft.b = pt(e);
      if (e.shiftKey && (draft.kind === "line" || draft.kind === "arrow")) {
        // Shift: snap to 45 degree steps
        const ang = Math.round(Math.atan2(draft.b.y - draft.a.y, draft.b.x - draft.a.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y);
        draft.b = { x: draft.a.x + len * Math.cos(ang), y: draft.a.y + len * Math.sin(ang) };
      }
    }
    paint(true);
  }

  function up() {
    if (dragFrom) {
      dragFrom = null;
      baseSkip = null;
      cv.style.cursor = "crosshair";
      return paint();
    }
    if (draft && draft.kind !== "eraser") commit(draft);
    draft = null;
    paint();
  }

  function eraseAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (hit(shapes[i], p)) {
        shapes.splice(i, 1);
        paint();
        return;
      }
    }
  }

  const undo = () => {
    selected = null;
    const s = shapes.pop();
    if (s) redoStack.push(s);
    paint();
  };
  const redo = () => {
    selected = null;
    const s = redoStack.pop();
    if (s) shapes.push(s);
    paint();
  };

  // ------------------------------------------------------------------- text
  function openEditor(p) {
    editor = document.createElement("div");
    editor.contentEditable = "plaintext-only";
    editor.className = "ed";
    const size = fontSize(width);
    editor.style.cssText = `left:${p.x}px;top:${p.y}px;font:600 ${size}px "Segoe UI",system-ui,sans-serif;color:${color};line-height:1.25`;
    editor.dataset.x = p.x;
    editor.dataset.y = p.y;
    root.appendChild(editor);
    editor.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeEditor(false);
      else if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), closeEditor(true));
    });
    editor.addEventListener("blur", () => closeEditor(true));
    editor.focus();
  }

  function closeEditor(keep) {
    if (!editor) return;
    const ed = editor;
    editor = null;
    const text = ed.innerText.replace(/\s+$/, "");
    ed.remove();
    if (keep && text) commit({ kind: "text", color: ed.style.color, width, text, a: { x: Number(ed.dataset.x), y: Number(ed.dataset.y) } });
    paint();
  }

  // --------------------------------------------------------------- shortcuts
  function onKey(e) {
    if (!frozen || editor) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let used = true;
    if (e.key === "Escape") clear();
    else if (mod && k === "z") (e.shiftKey ? redo : undo)();
    else if (mod && k === "y") redo();
    else if ((e.key === "Delete" || e.key === "Backspace") && selected) deleteSelected();
    else if (!mod && !e.altKey && KEYS[k]) tool = KEYS[k];
    else used = false;
    if (used) (e.preventDefault(), e.stopPropagation());
  }

  // ------------------------------------------------------------- freeze / clear
  async function freeze() {
    ensureUi();
    if (frozen) return { ok: true, already: true };
    const r = await chrome.runtime.sendMessage({ type: "snapshot" });
    if (!r?.url) throw new Error("could not take a picture of the page");
    bg.src = r.url;
    await bg.decode();
    bg.style.display = "block";
    cv.style.display = "block";
    cv.style.pointerEvents = "auto";
    cv.style.cursor = "crosshair";
    frozen = true;
    resizeCanvas();
    return { ok: true };
  }

  function clear() {
    if (!host) return;
    closeEditor(false);
    selected = dragFrom = baseSkip = null;
    frozen = false;
    shapes = [];
    redoStack = [];
    draft = null;
    bg.style.display = "none";
    cv.style.display = "none";
    cv.style.pointerEvents = "none";
    bg.removeAttribute("src");
  }

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m?.target === "offscreen") return; // not for us
    switch (m?.type) {
      case "report":
        report();
        reply({ ok: true });
        return;
      case "marker":
        ensureUi();
        mk.style.display = m.on ? "block" : "none";
        reply(geometry());
        return;
      case "freeze":
        freeze().then(reply, (e) => reply({ error: String(e.message ?? e) }));
        return true;
      case "tool":
        if (TOOLS.includes(m.tool)) tool = m.tool;
        if (tool !== "select") selected = null;
        if (m.color) color = m.color;
        if (m.width) width = m.width;
        reply({ ok: true });
        return;
      case "undo":
        undo();
        reply({ ok: true });
        return;
      case "redo":
        redo();
        reply({ ok: true });
        return;
      case "clear":
        clear();
        reply({ ok: true });
        return;
      case "state":
        reply({ frozen, shapes: shapes.length, tool, color, width, canRedo: redoStack.length > 0, selected: !!selected, firstShape: shapes[0] ? JSON.parse(JSON.stringify(shapes[0])) : null });
        return;
    }
  });
})();
