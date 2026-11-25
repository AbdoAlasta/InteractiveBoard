// Tiny server: serves the board and proxies requests to Gemini so the API key never reaches the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const PUBLIC_DIR = path.join(__dirname, "public");

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const SYSTEM_PROMPT = `You control a hand-drawn whiteboard rendered with rough.js.
The board is endless: coordinates can be any number, including negative; y grows downward.
Each request gives the "Visible area": the part of the board the user is looking at right now.
You receive the current scene (a JSON list of shapes) and the user's request.
Reply with one JSON object per line (JSON Lines) and nothing else: no code fences, no array, no prose.
Each line is one Action. Write shapes in the order they should be drawn (background/large shapes first).
The LAST line must be {"op":"message","text":"one short sentence describing what you did"}.

Action is one of:
  {"op":"add","shape":Shape}
  {"op":"update","id":string,"changes":object}   // shallow-merge into the shape; "options"/"animation" are merged too
  {"op":"delete","id":string}
  {"op":"clear"}

Shape = {"id": short unique string like "square1", "type": ..., geometry..., "options"?: Options, "animation"?: Animation}
Types and geometry:
  "rectangle": x, y, width, height          (x,y = top-left)
  "circle":    cx, cy, diameter
  "ellipse":   cx, cy, width, height
  "line":      x1, y1, x2, y2
  "curve":     points: [[x,y],...]          (smooth curve through >= 3 points)
  "linearPath":points: [[x,y],...]          (open polyline)
  "polygon":   points: [[x,y],...]          (closed)
  "arc":       cx, cy, width, height, start, stop (radians), closed (bool)
  "path":      d (SVG path string)
  "text":      x, y, text                   (x,y = left baseline; always drawn at 30px, about 15px wide per character)
Options (rough.js): stroke (css color), strokeWidth, fill (css color), fillStyle
  ("hachure","solid","zigzag","cross-hatch","dots","dashed","zigzag-line"), roughness (0-3), bowing.
Animation (optional, makes the shape move):
  {"type":"float","amplitude":px,"speed":cycles/sec}            gentle up/down bobbing
  {"type":"drift","dx":px,"dy":px,"speed":cycles/sec}           moves by (dx,dy) while fading out, then loops - good for things "floating out" of another shape
  {"type":"spin","speed":turns/sec}                             rotates around its own center
  {"type":"pulse","amount":0-1,"speed":cycles/sec}              grows and shrinks

Rules:
- Resolve references like "it", "the square", "that line" against the scene and recent requests.
- When something should "come from" or "attach to" another shape, compute coordinates so it starts exactly on that shape's edge.
- Place new shapes inside the visible area so the user sees them, sized to fit it; avoid overlapping unrelated existing shapes.
  A shape attached to an existing one goes next to that shape, even if it is outside the visible area.
- Reuse existing ids when modifying; never invent ids for delete/update that aren't in the scene.
- Be compact: integer coordinates, short ids, and only the options you actually need.`;

async function askGemini({ request, scene, history, view }, onAction) {
  const userText =
    `Visible area: x from ${view.x} to ${view.x + view.width}, y from ${view.y} to ${view.y + view.height}\n` +
    `Recent requests: ${JSON.stringify(history || [])}\n` +
    `Current scene: ${JSON.stringify(scene || [])}\n` +
    `Request: ${request}`;

  // Streamed, so each action can be drawn as soon as Gemini finishes writing its line.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      // Low thinking: ~2s instead of ~9s per request.
      generationConfig: { temperature: 0.4, thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Gemini returned ${res.status}`);
  }

  const emit = (line) => {
    line = line.trim();
    if (!line.startsWith("{")) return; // skips code fences or stray prose
    try { onAction(JSON.parse(line)); } catch { console.warn("Skipped unparsable line:", line); }
  };

  const decoder = new TextDecoder();
  let sse = "", text = "";
  for await (const chunk of res.body) {
    sse += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    let i;
    while ((i = sse.indexOf("\n\n")) >= 0) {
      const event = sse.slice(0, i);
      sse = sse.slice(i + 2);
      if (!event.startsWith("data:")) continue;
      const data = JSON.parse(event.slice(5));
      text += data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      let j;
      while ((j = text.indexOf("\n")) >= 0) {
        emit(text.slice(0, j));
        text = text.slice(j + 1);
      }
    }
  }
  emit(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/draw") {
      // Responds with JSON Lines: one action per line, sent as soon as Gemini writes it.
      const send = (action) => {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify(action) + "\n");
      };
      try {
        await askGemini(JSON.parse(await readBody(req)), send);
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end();
      } catch (err) {
        if (res.headersSent) return res.end(JSON.stringify({ op: "error", text: err.message }) + "\n");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const file = path.join(PUBLIC_DIR, req.url === "/" ? "index.html" : path.normalize(req.url));
    if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
    fs.readFile(file, (err, content) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(content);
    });
  })
  .listen(PORT, () => console.log(`Interactive board on http://localhost:${PORT} (model: ${MODEL})`));
