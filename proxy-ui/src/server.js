// proxy-ui/src/server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { rewriteHtml } = require("./plugins");

const PORT = parseInt(process.env.PORT || "8080", 10);
const RENDERER_URL = process.env.RENDERER_URL || "http://renderer:3001";
const TARGET_URL =
  process.env.TARGET_URL || "https://example.org/"; // стартовый URL

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// Загружаем клиентский JS для инъекции
const injectedPath = path.join(__dirname, "injected", "client.js");
let injectedJs = "";
try {
  injectedJs = fs.readFileSync(injectedPath, "utf8");
  log("INFO", `Loaded injected JS from ${injectedPath}`);
} catch (e) {
  log("ERR", `Cannot read injected JS: ${e.message}`);
}

// In-memory сессии: bui_sid -> { rendererSessionId, lastHtml, lastUrl, createdAt }
const sessions = new Map();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) return;
    const value = rest.join("=");
    out[decodeURIComponent(name)] = decodeURIComponent(value || "");
  });
  return out;
}

function getOrCreateSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  let sid = cookies.bui_sid;

  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    res.setHeader(
      "Set-Cookie",
      `bui_sid=${encodeURIComponent(
        sid
      )}; Path=/; HttpOnly; SameSite=Lax`
    );
    log("INFO", `New bui_sid=${sid} for ${req.socket.remoteAddress}`);
  }

  if (!sessions.has(sid)) {
    sessions.set(sid, {
      rendererSessionId: null,
      lastHtml: null,
      lastUrl: null,
      createdAt: Date.now()
    });
  }

  return { sid, data: sessions.get(sid) };
}

async function rendererStart(url) {
  const resp = await fetch(`${RENDERER_URL}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `renderer /session/start failed: ${resp.status} ${text}`
    );
  }

  return resp.json();
}

async function rendererNav(sessionId, href) {
  const resp = await fetch(`${RENDERER_URL}/session/nav`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, href })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `renderer /session/nav failed: ${resp.status} ${text}`
    );
  }

  return resp.json();
}

function injectClientJs(html) {
  if (!injectedJs) return html;
  const scriptTag = `<script>\n${injectedJs}\n</script>`;

  if (/%3C\/body%3E/i.test(html)) {
    // на случай urlencoded (вряд ли)
    return html.replace(/%3C\/body%3E/i, `${encodeURIComponent(scriptTag)}</body>`);
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scriptTag}</body>`);
  }
  return html + scriptTag;
}

function applyTransforms(html, req, session) {
  const ctx = {
    config: {}, // пока ничего особенного
    session,
    logger: {
      info: (m) => log("INFO", m),
      error: (m) => log("ERR", m)
    },
    request: {
      url: req.url,
      method: req.method,
      headers: req.headers
    }
  };

  let out = html;
  try {
    out = rewriteHtml(out, ctx);
  } catch (e) {
    log("ERR", `rewriteHtml error: ${e.message}`);
  }

  try {
    out = injectClientJs(out);
  } catch (e) {
    log("ERR", `injectClientJs error: ${e.message}`);
  }

  return out;
}

// --- Express app ---

const app = express();
app.use(express.json({ limit: "1mb" }));

// лог запросов
app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  next();
});

// Главная: либо создаём новую сессию в renderer, либо отдаём последний HTML
app.get("/", async (req, res) => {
  const { sid, data } = getOrCreateSession(req, res);

  try {
    if (!data.rendererSessionId) {
      log("INFO", `Session ${sid}: starting renderer session at ${TARGET_URL}`);
      const { sessionId, url, html } = await rendererStart(TARGET_URL);
      data.rendererSessionId = sessionId;
      data.lastHtml = html;
      data.lastUrl = url;
    }

    if (!data.lastHtml) {
      // на всякий случай, если вдруг нет кэша
      const { url, html } = await rendererNav(
        data.rendererSessionId,
        data.lastUrl || TARGET_URL
      );
      data.lastHtml = html;
      data.lastUrl = url;
    }

    const out = applyTransforms(data.lastHtml, req, data);
    res.status(200).set("Content-Type", "text/html; charset=utf-8").send(out);
  } catch (e) {
    log("ERR", `GET / error for sid=${sid}: ${e.message}`);
    res
      .status(502)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send("Renderer error");
  }
});

// Навигация по ссылке/форме: вызывается из инжектируемого JS
app.post("/__act/nav", async (req, res) => {
  const { sid, data } = getOrCreateSession(req, res);
  const href = (req.body && req.body.href) || "";

  if (!href) {
    return res.status(400).send("href is required");
  }
  if (!data.rendererSessionId) {
    // если почему-то навигация пришла раньше, чем мы стартовали сессию
    log("INFO", `Session ${sid}: lazy start renderer session at ${TARGET_URL}`);
    const startRes = await rendererStart(TARGET_URL);
    data.rendererSessionId = startRes.sessionId;
    data.lastHtml = startRes.html;
    data.lastUrl = startRes.url;
  }

  try {
    const { url, html } = await rendererNav(data.rendererSessionId, href);
    data.lastHtml = html;
    data.lastUrl = url;

    const out = applyTransforms(html, req, data);
    res.status(200).set("Content-Type", "text/html; charset=utf-8").send(out);
  } catch (e) {
    log("ERR", `POST /__act/nav error for sid=${sid}: ${e.message}`);
    res
      .status(502)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send("Renderer nav error");
  }
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.listen(PORT, () => {
  log("INFO", `proxy-ui listening on http://0.0.0.0:${PORT}`);
  log("INFO", `Renderer URL: ${RENDERER_URL}`);
  log("INFO", `Target URL: ${TARGET_URL}`);
});
