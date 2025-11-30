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
 * Инлайним CSS и <img/src|data-src|srcset|source> поверх HTML.
 */
function inlineAssets(html, urlNow, cssChunks, imageMap, sessionId) {
  // 1) CSS
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

  // 2) <img> и <source srcset> → data:
  try {
    const $ = cheerio.load(html);

    function inlineImgLike($el, attrName) {
      const srcVal = $el.attr(attrName);
      if (!srcVal) return false;

      // srcset может содержать несколько URL, берём первый
      let candidate = srcVal.trim();
      if (attrName === "srcset") {
        const firstPart = candidate.split(",")[0].trim();
        candidate = firstPart.split(/\s+/)[0]; // до пробела (без "2x" и т.п.)
      }

      if (!candidate || candidate.startsWith("data:")) return false;

      let absUrl;
      try {
        absUrl = new URL(candidate, urlNow).toString();
      } catch {
        return false;
      }

      const img = imageMap.get(absUrl);
      if (!img) return false;

      const contentType =
        img.contentType ||
        (absUrl.endsWith(".png")
          ? "image/png"
          : absUrl.endsWith(".jpg") || absUrl.endsWith(".jpeg")
          ? "image/jpeg"
          : absUrl.endsWith(".webp")
          ? "image/webp"
          : "image/*");

      const dataUrl = `data:${contentType};base64,${img.data}`;
      $el.attr("src", dataUrl);
      $el.removeAttr("data-src");
      $el.removeAttr("data-original");
      $el.removeAttr("srcset");
      log(
        "INFO",
        `Session ${sessionId}: inlined <img> from ${absUrl} (len=${img.data.length})`
      );
      return true;
    }

    $("img").each((_, el) => {
      const $el = $(el);

      if (
        inlineImgLike($el, "data-src") ||
        inlineImgLike($el, "data-original") ||
        inlineImgLike($el, "src") ||
        inlineImgLike($el, "srcset")
      ) {
        // ок
      }
    });

    $("source[srcset]").each((_, el) => {
      const $el = $(el);
      const srcset = $el.attr("srcset");
      if (!srcset) return;

      const firstPart = srcset.split(",")[0].trim();
      const candidate = firstPart.split(/\s+/)[0];
      if (!candidate || candidate.startsWith("data:")) return;

      let absUrl;
      try {
        absUrl = new URL(candidate, urlNow).toString();
      } catch {
        return;
      }

      const img = imageMap.get(absUrl);
      if (!img) return;

      const contentType =
        img.contentType ||
        (absUrl.endsWith(".png")
          ? "image/png"
          : absUrl.endsWith(".jpg") || absUrl.endsWith(".jpeg")
          ? "image/jpeg"
          : absUrl.endsWith(".webp")
          ? "image/webp"
          : "image/*");

      const dataUrl = `data:${contentType};base64,${img.data}`;
      $el.attr("srcset", dataUrl);
      log(
        "INFO",
        `Session ${sessionId}: inlined <source> from ${absUrl} (len=${img.data.length})`
      );
    });

    html = $.html();
  } catch (e) {
    log("ERR", `Session ${sessionId}: cheerio HTML rewrite error: ${e.message}`);
  }

  return html;
}

/**
 * Общий helper: вешаем page.on('response'), выполняем action(),
 * опционально ждём networkidle, снимаем HTML и инлайним всё.
 *
 * requireIdle:
 *   - для goto можно не ставить (page.goto сам ждёт по waitUntil)
 *   - для submit полезно чуть подождать networkidle, но НЕ падать по таймауту
 */
async function capturePageAssets(sessionId, page, action, { requireIdle }) {
  const cssChunks = [];
  const imageMap = new Map();

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
    await action();

    if (requireIdle) {
      try {
        await page.waitForLoadState("networkidle", { timeout: 10000 });
      } catch (e) {
        log(
          "WARN",
          `Session ${sessionId}: waitForLoadState(networkidle) timeout/err: ${e.message}`
        );
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  const htmlRaw = await page.content();
  const urlNow = page.url();
  const html = inlineAssets(htmlRaw, urlNow, cssChunks, imageMap, sessionId);

  return { url: urlNow, html };
}

async function createSession(startUrl) {
  const br = await getBrowser();
  const context = await br.newContext();
  const page = await context.newPage();

  const sessionId = crypto.randomBytes(16).toString("hex");
  log("INFO", `New renderer session ${sessionId}: goto ${startUrl}`);

  const { url, html } = await capturePageAssets(
    sessionId,
    page,
    () =>
      page.goto(startUrl, {
        waitUntil: "networkidle",
        timeout: 60000
      }),
    { requireIdle: false }
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

  const { url, html } = await capturePageAssets(
    sessionId,
    page,
    () =>
      page.goto(targetUrl, {
        waitUntil: "networkidle",
        timeout: 60000
      }),
    { requireIdle: false }
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

  // НЕ кидаем ошибку, если формы нет — просто вернём текущий html.
  const action = async () => {
    const didSubmit = await page.evaluate((fields) => {
      const form = document.querySelector("form");
      if (!form) {
        console.warn("No <form> found on the page");
        return false;
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
      return true;
    }, fields);

    if (!didSubmit) {
      // форма не найдена — ничего не делаем, просто вернём текущий снимок
      log(
        "INFO",
        `Session ${sessionId}: submit called, but no <form> found; returning current HTML`
      );
    }
  };

  // После submit ждём немного networkidle, но НЕ падаем по таймауту.
  const { url, html } = await capturePageAssets(sessionId, page, action, {
    requireIdle: true
  });
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

// Сабмит формы (капчи/логин/прочие POST)
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
