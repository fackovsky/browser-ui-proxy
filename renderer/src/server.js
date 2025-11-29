// renderer/src/server.js
const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");
const cheerio = require("cheerio");

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

/**
 * Переписать url(...) внутри CSS на data: URI, если у нас есть содержимое картинки.
 */
function rewriteCssUrls(cssText, baseUrl, imageMap) {
  if (!cssText || typeof cssText !== "string") return cssText;

  return cssText.replace(/url\(([^)]+)\)/gi, (match, p1) => {
    let inside = p1.trim();
    if (!inside) return match;

    let quote = "";
    const first = inside[0];
    const last = inside[inside.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      quote = first;
      inside = inside.slice(1, -1).trim();
    }

    if (!inside || inside.startsWith("data:")) {
      return match;
    }

    let absUrl;
    try {
      absUrl = new URL(inside, baseUrl).toString();
    } catch {
      return match;
    }

    const img = imageMap.get(absUrl);
    if (!img) {
      return match;
    }

    const contentType = img.contentType || "image/*";
    const dataUrl = `data:${contentType};base64,${img.data}`;
    const finalUrl = quote ? `${quote}${dataUrl}${quote}` : dataUrl;

    return `url(${finalUrl})`;
  });
}

/**
 * Общая функция: выполнить действие (goto или form.submit),
 * параллельно собрать CSS и картинки, и вернуть HTML с инлайном.
 */
async function runActionWithAssets(sessionId, page, action) {
  const cssChunks = []; // { baseUrl, text }
  const imageMap = new Map(); // absUrl -> { contentType, data(base64) }

  const onResponse = async (response) => {
    try {
      const req = response.request();
      const resUrl = response.url();
      const headers = response.headers() || {};
      const ct = (headers["content-type"] || "").toLowerCase();

      const resourceType = req.resourceType();
      const isStylesheet =
        resourceType === "stylesheet" || ct.includes("text/css");
      const isImage =
        resourceType === "image" || ct.startsWith("image/");

      if (isStylesheet && response.ok()) {
        const text = await response.text();
        if (text && text.trim().length > 0) {
          cssChunks.push({ baseUrl: resUrl, text });
          log(
            "INFO",
            `Session ${sessionId}: captured CSS from ${resUrl} (${text.length} bytes)`
          );
        }
      } else if (isImage && response.ok()) {
        const body = await response.body();
        if (body && body.length > 0) {
          let contentType = ct;
          if (!contentType) {
            if (resUrl.endsWith(".png")) contentType = "image/png";
            else if (resUrl.endsWith(".jpg") || resUrl.endsWith(".jpeg"))
              contentType = "image/jpeg";
            else if (resUrl.endsWith(".gif")) contentType = "image/gif";
            else if (resUrl.endsWith(".webp")) contentType = "image/webp";
          }
          imageMap.set(resUrl, {
            contentType,
            data: body.toString("base64")
          });
          log(
            "INFO",
            `Session ${sessionId}: captured IMAGE from ${resUrl} (${body.length} bytes)`
          );
        }
      }
    } catch (e) {
      log("ERR", `Response handler error in session ${sessionId}: ${e.message}`);
    }
  };

  page.on("response", onResponse);

  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }),
      action()
    ]);
  } catch (e) {
    page.off("response", onResponse);
    throw e;
  }

  page.off("response", onResponse);

  let html = await page.content();
  const urlNow = page.url();

  // 1) Инлайн CSS с переписанными url(...)
  if (cssChunks.length > 0) {
    let combinedCss =
      "\n/* ---- inlined styles captured by renderer ---- */\n";
    for (const chunk of cssChunks) {
      const rewritten = rewriteCssUrls(
        chunk.text,
        chunk.baseUrl,
        imageMap
      );
      combinedCss += rewritten + "\n";
    }
    const styleTag = `<style>${combinedCss}</style>`;

    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${styleTag}</head>`);
    } else {
      html = styleTag + html;
    }
    log(
      "INFO",
      `Session ${sessionId}: inlined ${cssChunks.length} CSS resources (with images where possible)`
    );
  } else {
    log("INFO", `Session ${sessionId}: no CSS captured`);
  }

  // 2) Инлайн <img src="..."> используя imageMap
  try {
    const $ = cheerio.load(html);

    $('img[src]').each((_, el) => {
      const $el = $(el);
      const src = $el.attr("src");
      if (!src) return;

      try {
        const absUrl = new URL(src, urlNow).toString();
        const img = imageMap.get(absUrl);
        if (!img) return;

        const contentType = img.contentType || "image/*";
        const dataUrl = `data:${contentType};base64,${img.data}`;
        $el.attr("src", dataUrl);

        log(
          "INFO",
          `Session ${sessionId}: inlined <img> from ${absUrl} (len=${img.data.length})`
        );
      } catch (e) {
        log(
          "ERR",
          `Session ${sessionId}: img src rewrite error for "${src}": ${e.message}`
        );
      }
    });

    html = $.html();
  } catch (e) {
    log("ERR", `Session ${sessionId}: cheerio HTML rewrite error: ${e.message}`);
  }

  return { url: urlNow, html };
}

async function createSession(startUrl) {
  const br = await getBrowser();
  const context = await br.newContext();
  const page = await context.newPage();

  const sessionId = crypto.randomBytes(16).toString("hex");
  log("INFO", `New renderer session ${sessionId}: goto ${startUrl}`);

  const { url, html } = await runActionWithAssets(sessionId, page, () =>
    page.goto(startUrl)
  );

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

  log("INFO", `Session ${sessionId}: nav to ${targetUrl}`);

  const { url, html } = await runActionWithAssets(sessionId, page, () =>
    page.goto(targetUrl)
  );
  sess.lastUrl = url;

  return { url, html };
}

async function submitSession(sessionId, fields) {
  const sess = sessions.get(sessionId);
  if (!sess) {
    throw new Error(`Unknown sessionId: ${sessionId}`);
  }

  const { page, lastUrl } = sess;
  log("INFO", `Session ${sessionId}: submit form on ${lastUrl || page.url()}`);

  const action = () =>
    page.evaluate((fields) => {
      const form = document.querySelector("form");
      if (!form) {
        throw new Error("No <form> found on the page");
      }

      for (const [name, value] of Object.entries(fields)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) continue;

        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
          el.value = value;
        }
      }

      form.submit();
    }, fields);

  const { url, html } = await runActionWithAssets(sessionId, page, action);
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

// Сабмит формы (например, капча)
app.post("/session/submit", async (req, res) => {
  const { sessionId, fields } = req.body || {};
  if (!sessionId || !fields || typeof fields !== "object") {
    return res
      .status(400)
      .json({ error: "sessionId and fields are required" });
  }

  try {
    const result = await submitSession(sessionId, fields);
    res.status(200).json(result);
  } catch (e) {
    log("ERR", `session/submit error: ${e.message}`);
    if (/Unknown sessionId/.test(e.message)) {
      res.status(404).json({ error: e.message });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.listen(PORT, () => {
  log("INFO", `Renderer listening on 0.0.0.0:${PORT}`);
});
