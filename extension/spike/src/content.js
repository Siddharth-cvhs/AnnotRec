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
      img,canvas,div{position:fixed;left:0;top:0;width:100vw;height:100vh;display:none}
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
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    addEventListener("keydown", (e) => e.key === "Escape" && frozen && (e.stopPropagation(), clear()), true);
    addEventListener("resize", () => frozen && resizeCanvas());
  }

  function resizeCanvas() {
    const dpr = devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    paint();
  }

  // ---------------------------------------------------------------- drawing
  function draw(s) {
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    if (s.kind === "pen") {
      ctx.beginPath();
      s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (s.kind === "rect") {
      ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
    } else if (s.kind === "arrow") {
      ctx.beginPath();
      ctx.moveTo(s.a.x, s.a.y);
      ctx.lineTo(s.b.x, s.b.y);
      ctx.stroke();
      const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const head = Math.max(14, s.width * 4);
      ctx.beginPath();
      ctx.moveTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - head * Math.cos(ang - 0.45), s.b.y - head * Math.sin(ang - 0.45));
      ctx.lineTo(s.b.x - head * Math.cos(ang + 0.45), s.b.y - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function paint() {
    if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    shapes.forEach(draw);
    if (draft) draw(draft);
  }

  const pt = (e) => ({ x: e.clientX, y: e.clientY });

  function down(e) {
    if (e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const p = pt(e);
    draft = tool === "pen" ? { kind: "pen", color, width, pts: [p] } : { kind: tool, color, width, a: p, b: p };
    paint();
  }

  function move(e) {
    if (!draft) return;
    if (draft.kind === "pen") draft.pts.push(pt(e));
    else draft.b = pt(e);
    paint();
  }

  function up() {
    if (draft) shapes.push(draft);
    draft = null;
    paint();
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
    frozen = false;
    shapes = [];
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
        tool = m.tool;
        if (m.color) color = m.color;
        if (m.width) width = m.width;
        reply({ ok: true });
        return;
      case "clear":
        clear();
        reply({ ok: true });
        return;
      case "state":
        reply({ frozen, shapes: shapes.length, tool });
        return;
    }
  });
})();
