// renderer/src/server.js
const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3001;
const TOR_SOCKS = process.env.TOR_SOCKS || ""; // например: socks5://tor:9050

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

let browser;
const sessions = new Map(); // sessionId -> { context, page, lastUrl }

async function getBrowser() {
  if (browser) return browser;

  const launchOptions = { headless: true };
  if (TOR_SOCKS) {
    launchOptions.proxy = { server: TOR_SOCKS };
    log("INFO", `Playwright proxy: ${TOR_SOCKS}`);
  }

  browser = await chromium.launch(launchOptions);
  log("INFO", "Headless Chromium started");
  return browser;
}

// общая функция: goto + сбор CSS + возвращение html
async function gotoWithInlineCss(sessionId, page, targetUrl) {
  const cssChunks = [];

  const onResponse = async (response) => {
    try {
      const req = response.request();
      const headers = response.headers() || {};
      const ct = (headers["content-type"] || "").toLowerCase();
      const isStylesheet =
        req.resourceType() === "stylesheet" || ct.includes("text/css");

      if (isStylesheet && response.ok()) {
        const text = await response.text();
        if (text && text.trim().length > 0) {
          cssChunks.push(text);
          log(
            "INFO",
            `Session ${sessionId}: captured CSS from ${response.url()} (${text.length} bytes)`
          );
        }
      }
    } catch (e) {
      log("ERR", `CSS capture error in session ${sessionId}: ${e.message}`);
    }
  };

  page.on("response", onResponse);

  log("INFO", `Session ${sessionId}: goto ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });

  page.off("response", onResponse);

  let html = await page.content();
  const urlNow = page.url();

  if (cssChunks.length > 0) {
    const inlineCss =
      "\n/* ---- inlined styles captured by renderer ---- */\n" +
      cssChunks.join("\n");
    const styleTag = `<style>${inlineCss}</style>`;

    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${styleTag}</head>`);
    } else {
      html = styleTag + html;
    }
    log(
      "INFO",
      `Session ${sessionId}: inlined ${cssChunks.length} CSS resources into HTML`
    );
  } else {
    log("INFO", `Session ${sessionId}: no CSS captured for ${targetUrl}`);
  }

  return { url: urlNow, html };
}

async function createSession(startUrl) {
  const br = await getBrowser();
  const context = await br.newContext();
  const page = await context.newPage();

  const sessionId = crypto.randomBytes(16).toString("hex");
  log("INFO", `New renderer session ${sessionId}: goto ${startUrl}`);

  const { url, html } = await gotoWithInlineCss(sessionId, page, startUrl);

  sessions.set(sessionId, { context, page, lastUrl: url });
  log("INFO", `Session ${sessionId} created at ${url}`);

  return { sessionId, url, html };
}

async function navSession(sessionId, href) {
  const sess = sessions.get(sessionId);
  if (!sess) {
    throw new Error(`Unknown sessionId: ${sessionId}`);
  }

  const { page, lastUrl } = sess;
  const baseUrl = lastUrl || page.url() || href;
  const targetUrl = new URL(href, baseUrl).toString();

  const { url, html } = await gotoWithInlineCss(sessionId, page, targetUrl);
  sess.lastUrl = url;

  return { url, html };
}

// --- Express server ---

const app = express();
app.use(express.json({ limit: "1mb" }));

// Создать новую сессию и открыть стартовый URL
app.post("/session/start", async (req, res) => {
  const url = (req.body && req.body.url) || "";
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const result = await createSession(url);
    res.status(200).json(result);
  } catch (e) {
    log("ERR", `session/start error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Навигация внутри существующей сессии
app.post("/session/nav", async (req, res) => {
  const { sessionId, href } = req.body || {};
  if (!sessionId || !href) {
    return res
      .status(400)
      .json({ error: "sessionId and href are required" });
  }

  try {
    const result = await navSession(sessionId, href);
    res.status(200).json(result);
  } catch (e) {
    log("ERR", `session/nav error: ${e.message}`);
    if (/Unknown sessionId/.test(e.message)) {
      res.status(404).json({ error: e.message });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// (опционально) healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.listen(PORT, () => {
  log("INFO", `Renderer listening on 0.0.0.0:${PORT}`);
});
