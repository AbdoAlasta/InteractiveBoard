const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const rc = rough.canvas(canvas);
const gen = rc.generator;

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("prompt");
const sendBtn = document.getElementById("send");

let shapes = [];         // scene, as Gemini sees it
const drawables = {};    // id -> cached rough drawable (fixed seed keeps the sketch stable between frames)
const strokeCache = {};  // id -> drawable split into measured strokes, for the draw-in animation
const reveals = {};      // id -> { start, dur } in ms: when the shape is being sketched in
let revealQueueEnd = 0;  // new shapes are sketched one after another

// Hidden SVG path used only to measure stroke lengths.
const measureSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
measureSvg.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
const measurePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
measureSvg.appendChild(measurePath);
document.body.appendChild(measureSvg);
const history = [];      // recent user requests, for resolving "it" / "that"
let width = 0, height = 0, dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
}
window.addEventListener("resize", resize);
resize();
document.fonts.load("24px Kalam"); // canvas text only uses a web font once it's loaded

// ---------- endless board: camera ----------
// Shapes live in world coordinates; the camera maps them to the screen: screen = (world - cam) * zoom.
const cam = { x: 0, y: 0, zoom: 1 };

function view() { // visible world rectangle
  return { x: Math.round(cam.x), y: Math.round(cam.y), width: Math.round(width / cam.zoom), height: Math.round(height / cam.zoom) };
}

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  cam.x -= (e.clientX - drag.x) / cam.zoom;
  cam.y -= (e.clientY - drag.y) / cam.zoom;
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", () => { drag = null; canvas.style.cursor = "grab"; });

// Wheel / two-finger scroll pans; Ctrl+wheel or trackpad pinch zooms around the cursor.
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const wx = cam.x + sx / cam.zoom, wy = cam.y + sy / cam.zoom; // world point under the cursor
    cam.zoom = Math.min(8, Math.max(0.1, cam.zoom * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.005)));
    cam.x = wx - sx / cam.zoom;
    cam.y = wy - sy / cam.zoom;
  } else {
    cam.x += e.deltaX / cam.zoom;
    cam.y += e.deltaY / cam.zoom;
  }
}, { passive: false });

// Faint dot grid so panning and zooming are visible.
function drawGrid() {
  let step = 40;
  while (step * cam.zoom < 20) step *= 2;
  const { x, y, width: w, height: h } = view();
  ctx.fillStyle = "#d9d3c5";
  const r = 1.2 / cam.zoom;
  for (let gx = Math.floor(x / step) * step; gx < x + w + step; gx += step)
    for (let gy = Math.floor(y / step) * step; gy < y + h + step; gy += step)
      ctx.fillRect(gx - r, gy - r, 2 * r, 2 * r);
}

// ---------- shape -> rough.js ----------
function buildDrawable(s) {
  const o = { seed: s.seed, ...s.options };
  switch (s.type) {
    case "rectangle": return gen.rectangle(s.x, s.y, s.width, s.height, o);
    case "circle":    return gen.circle(s.cx, s.cy, s.diameter, o);
    case "ellipse":   return gen.ellipse(s.cx, s.cy, s.width, s.height, o);
    case "line":      return gen.line(s.x1, s.y1, s.x2, s.y2, o);
    case "curve":     return gen.curve(s.points, o);
    case "linearPath":return gen.linearPath(s.points, o);
    case "polygon":   return gen.polygon(s.points, o);
    case "arc":       return gen.arc(s.cx, s.cy, s.width, s.height, s.start, s.stop, !!s.closed, o);
    case "path":      return gen.path(s.d, o);
    default:          return null; // "text" is drawn directly
  }
}

// Split a rough drawable into strokes we can reveal gradually: outline first, then fill.
function buildStrokes(drawable) {
  const o = drawable.options;
  const outline = [], fill = [];
  for (const set of drawable.sets) {
    const d = gen.opsToPath(set);
    if (set.type === "fillPath") {
      fill.push({ path: new Path2D(d), len: 0, color: o.fill, solid: true });
      continue;
    }
    // Each "M" starts a separate pen stroke; split so they are drawn one after another.
    for (const part of d.split(/(?=M)/)) {
      measurePath.setAttribute("d", part);
      const stroke = { path: new Path2D(part), len: measurePath.getTotalLength() || 1 };
      if (set.type === "path") outline.push({ ...stroke, color: o.stroke, width: o.strokeWidth });
      else fill.push({ ...stroke, color: o.fill, width: o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight });
    }
  }
  return { outline, fill };
}

// Draw a list of strokes, revealing fraction p (0..1) of their combined length in order.
function drawStrokes(strokes, p) {
  const total = strokes.reduce((sum, s) => sum + s.len, 0);
  let budget = p * total;
  for (const s of strokes) {
    if (s.solid) {
      ctx.save(); ctx.globalAlpha *= p; ctx.fillStyle = s.color; ctx.fill(s.path); ctx.restore();
      continue;
    }
    if (budget <= 0) break;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.setLineDash([Math.min(budget, s.len), s.len + 1]);
    ctx.stroke(s.path);
    budget -= s.len;
  }
  ctx.setLineDash([]);
}

function drawPartial(s, p) {
  strokeCache[s.id] ??= buildStrokes(drawables[s.id]);
  const { outline, fill } = strokeCache[s.id];
  if (!fill.length) return drawStrokes(outline, p);
  drawStrokes(outline, Math.min(1, p * 2));     // first half: outline
  if (p > 0.5) drawStrokes(fill, (p - 0.5) * 2); // second half: fill
}

function center(s) {
  switch (s.type) {
    case "rectangle": return [s.x + s.width / 2, s.y + s.height / 2];
    case "circle": case "ellipse": case "arc": return [s.cx, s.cy];
    case "line": return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
    case "text": return [s.x, s.y];
    default:
      if (Array.isArray(s.points) && s.points.length) {
        const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
        return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      }
      const v = view();
      return [v.x + v.width / 2, v.y + v.height / 2];
  }
}

// ---------- scene changes from Gemini ----------
function applyActions(actions = []) {
  for (const a of actions) {
    if (a.op === "clear") {
      shapes = [];
    } else if (a.op === "add" && a.shape) {
      const s = { ...a.shape, seed: Math.floor(Math.random() * 2 ** 31) };
      if (!s.id || shapes.some((x) => x.id === s.id)) s.id = `${s.type}${Date.now() % 100000}`;
      shapes.push(s);
      const dur = s.type === "text" ? Math.max(300, (s.text || "").length * 40) : 600;
      const start = Math.max(performance.now(), revealQueueEnd);
      reveals[s.id] = { start, dur };
      revealQueueEnd = start + dur;
    } else if (a.op === "update") {
      const s = shapes.find((x) => x.id === a.id);
      if (!s) continue;
      const { options, animation, ...rest } = a.changes || {};
      Object.assign(s, rest);
      if (options) s.options = { ...s.options, ...options };
      if (animation !== undefined) s.animation = animation && { ...s.animation, ...animation };
    } else if (a.op === "delete") {
      shapes = shapes.filter((x) => x.id !== a.id);
    }
  }
  for (const k in drawables) delete drawables[k]; // rebuild with the same seeds
  for (const k in strokeCache) delete strokeCache[k];
}

// ---------- render loop ----------
function render(time) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const k = dpr * cam.zoom;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
  drawGrid();

  for (const s of shapes) {
    try {
      ctx.save();
      // Draw-in progress (0..1); movement animations start once the shape is fully sketched.
      const rev = reveals[s.id];
      const p = rev ? Math.min(1, Math.max(0, (time - rev.start) / rev.dur)) : 1;
      if (p === 0) continue;
      const t = rev ? (time - rev.start - rev.dur) / 1000 : time / 1000;
      const anim = p === 1 && s.animation;
      if (anim) {
        const [cx, cy] = center(s);
        const speed = anim.speed ?? 0.5;
        if (anim.type === "float") {
          ctx.translate(0, Math.sin(t * speed * 2 * Math.PI) * (anim.amplitude ?? 10));
        } else if (anim.type === "drift") {
          const p = (t * speed) % 1;
          ctx.translate((anim.dx ?? 0) * p, (anim.dy ?? -100) * p);
          ctx.globalAlpha = 1 - p;
        } else if (anim.type === "spin") {
          ctx.translate(cx, cy);
          ctx.rotate(t * speed * 2 * Math.PI);
          ctx.translate(-cx, -cy);
        } else if (anim.type === "pulse") {
          const k = 1 + Math.sin(t * speed * 2 * Math.PI) * (anim.amount ?? 0.15);
          ctx.translate(cx, cy);
          ctx.scale(k, k);
          ctx.translate(-cx, -cy);
        }
      }

      if (s.type === "text") {
        ctx.fillStyle = s.options?.stroke || s.options?.fill || "#222";
        ctx.font = "30px Kalam, cursive"; // fixed size for all board text
        const text = s.text ?? "";
        ctx.fillText(text.slice(0, Math.ceil(text.length * p)), s.x, s.y);
      } else {
        drawables[s.id] ??= buildDrawable(s);
        if (!drawables[s.id]) continue;
        if (p < 1) drawPartial(s, p);
        else rc.draw(drawables[s.id]);
      }
    } catch (err) {
      console.warn("Could not draw shape", s, err);
    } finally {
      ctx.restore();
    }
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------- chat ----------
function addMsg(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const request = input.value.trim();
  if (!request) return;
  input.value = "";
  addMsg(request, "user");
  sendBtn.disabled = true;

  try {
    const scene = shapes.map(({ seed, ...s }) => s);
    const res = await fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request, scene, history: history.slice(-6), view: view() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Request failed");

    // Draw each action as soon as its line arrives.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", message = "Done.";
    const handle = (line) => {
      if (!line.trim()) return;
      const a = JSON.parse(line);
      if (a.op === "message") message = a.text;
      else if (a.op === "error") throw new Error(a.text);
      else applyActions([a]);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    handle(buf);
    history.push(request);
    addMsg(message, "bot");
  } catch (err) {
    addMsg(err.message, "error");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

document.getElementById("clear").addEventListener("click", () => {
  applyActions([{ op: "clear" }]);
  history.length = 0;
});
