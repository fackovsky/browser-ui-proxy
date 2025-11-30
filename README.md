````markdown
# browser-ui-proxy (bui)

“Удалённый браузер” поверх Tor:  
под капотом крутится настоящий Chromium (Playwright + Tor),  
а пользователю отдаётся только **HTML-снимок** страницы с нашими плагинами и инжектами.

Ключевая идея:

> Клиент **никогда не ходит** к таргету напрямую.  
> Все запросы к сайту делает **только headless-браузер** (Playwright через Tor).  
> Пользователь видит только результат (HTML) и взаимодействует через прокси.

---

## Архитектура

Проект состоит из трёх сервисов:

- **`bui-tor`** (`tor/`):
  - Tor в Docker;
  - SOCKS-прокси `socks5://tor:9050` для Playwright;
  - hidden service для `bui-proxy-ui`, ключи лежат в `tor/keys` (адрес `proxy…onion`).

- **`bui-renderer`** (`renderer/`):
  - Node.js + Playwright (Chromium);
  - поднимает один браузер и несколько контекстов (сеансов);
  - для каждого сеанса:
    - открывает страницы через Tor;
    - собирает CSS и картинки;
    - инлайнит стили и `<img>` в HTML;
  - API:
    - `POST /session/start { url }` → `{ sessionId, url, html }`;
    - `POST /session/nav { sessionId, href }` → `{ url, html }`;
    - `POST /session/submit { sessionId, fields }` → `{ url, html }`.

- **`bui-proxy-ui`** (`proxy-ui/`):
  - Express-приложение для браузера пользователя;
  - ведёт свои сессии по cookie `bui_sid`;
  - для каждой сессии создаёт **одну** Playwright-сессию (`rendererSessionId`);
  - отдаёт HTML, модифицированный плагинами (`Cheerio`) и с инжектированным JS;
  - клиентский JS:
    - перехватывает клики по ссылкам и submit форм;
    - отправляет действия на `/__act/nav` и `/__act/submit`;
    - получает новый HTML-снимок и полностью перерисовывает страницу.

Упрощённая схема:

```text
   Browser (user)
         │
         │ HTTP (GET /, POST /__act/*)
         ▼
   bui-proxy-ui (Express)
         │ JSON (session/start|nav|submit)
         ▼
   bui-renderer (Playwright → Tor)
         │
         ▼
   .onion / clearnet сайты
````

---

## Структура проекта

```text
browser-ui-proxy/
  docker-compose.yml

  tor/
    Dockerfile
    torrc
    keys/                      # hs_ed25519_* + hostname

  renderer/
    Dockerfile
    package.json
    src/
      server.js                # API: /session/start, /session/nav, /session/submit

  proxy-ui/
    Dockerfile
    package.json
    src/
      server.js                # HTTP-прокси для пользователей
      plugins/
        index.js               # движок плагинов (Cheerio)
        config.json            # конфиг плагинов
        append-to-title.js     # пример плагина
      injected/
        client.js              # инжектируемый JS
```

---

## docker-compose

`docker-compose.yml`:

```yaml
version: "3.9"

services:
  tor:
    build: ./tor
    container_name: bui-tor
    restart: unless-stopped
    networks:
      - bui-net
    volumes:
      - ./tor/keys:/var/lib/tor/bui-onion-proxy

  renderer:
    build: ./renderer
    container_name: bui-renderer
    restart: unless-stopped
    depends_on:
      - tor
    networks:
      - bui-net
    environment:
      - PORT=3001
      - TOR_SOCKS=socks5://tor:9050

  proxy-ui:
    build: ./proxy-ui
    container_name: bui-proxy-ui
    restart: unless-stopped
    depends_on:
      - renderer
    networks:
      - bui-net
    environment:
      - TARGET_URL=http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/
      - PORT=8080
      - RENDERER_URL=http://renderer:3001
    ports:
      - "8081:8080"

networks:
  bui-net:
    driver: bridge
```

---

## Tor (`bui-tor`)

### `tor/Dockerfile`

```dockerfile
FROM alpine:3.19
RUN apk add --no-cache tor

# создаём директорию под hidden service
RUN mkdir -p /var/lib/tor/bui-onion-proxy && \
    chmod 700 /var/lib/tor/bui-onion-proxy

COPY torrc /etc/tor/torrc

CMD ["tor"]
```

### `tor/torrc`

```text
SocksPort 0.0.0.0:9050
SocksPolicy accept *

Log notice stdout

HiddenServiceDir /var/lib/tor/bui-onion-proxy
HiddenServiceVersion 3
HiddenServicePort 80 bui-proxy-ui:8080
```

### Ключи hidden service

В `tor/keys` должны лежать:

```text
tor/keys/
  hs_ed25519_secret_key
  hs_ed25519_public_key
  hostname
```

Рекомендуемые права:

```bash
chmod 700 tor/keys
chmod 600 tor/keys/hs_ed25519_secret_key
chmod 644 tor/keys/hs_ed25519_public_key
chmod 644 tor/keys/hostname
```

После запуска:

```bash
docker compose exec tor cat /var/lib/tor/bui-onion-proxy/hostname
```

→ это твой `.onion`-адрес прокси (например, начиная с `proxy…onion`).

---

## Renderer (`bui-renderer`)

### `renderer/Dockerfile`

```dockerfile
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/server.js"]
```

### `renderer/package.json`

```json
{
  "name": "browser-ui-renderer",
  "version": "0.1.0",
  "main": "src/server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "express": "^4.19.0",
    "playwright": "1.47.0",
    "cheerio": "^1.0.0-rc.12"
  }
}
```

### Логика renderer (с учётом текущего кода)

* Глобальный Chromium (`chromium.launch`) с прокси `TOR_SOCKS`.
* `sessions` (Map): `sessionId -> { context, page, lastUrl }`.

#### Сбор HTML + CSS + картинок

Функция `runActionWithAssets(sessionId, page, action)`:

* вешает `page.on("response")`:

  * если `text/css` → собирает CSS в `cssChunks`;
  * если `image/*` → кладёт байты в `imageMap` (key = полный URL).

* параллельно делает:

  ```js
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }),
    action()
  ]);
  ```

  где `action()` — либо `page.goto(url)`, либо `page.evaluate(form.submit)`.

* затем берёт `html = await page.content()`, `urlNow = page.url()`;

* инлайнит:

  1. **CSS**: вставляет `<style>...cssChunks...</style>` перед `</head>`;
  2. **фоновые картинки**: переписывает `url(...)` в CSS на `data:image/...;base64,...` если URL есть в `imageMap`;
  3. **картинки товара**:

     * перебирает `<img>`:

       * сначала `data-src`, `data-original`, затем `src` и `srcset`;
       * если URL найдён в `imageMap` → делает `src="data:image/...;base64,..."`;
     * перебирает `<source srcset>` в `<picture>`:

       * аналогично преобразует в `data:` URI.

→ На выходе получается **самодостаточный HTML**: стили и картинки встроены, браузеру пользователя не нужно ходить за `/css/*.css` или `/storage/image/*.webp`.

#### `/session/start`

```js
app.post("/session/start", async (req, res) => {
  const url = req.body?.url;
  const br = await getBrowser();
  const context = await br.newContext();
  const page = await context.newPage();
  const sessionId = crypto.randomBytes(16).toString("hex");

  const { url: urlNow, html } = await runActionWithAssets(
    sessionId,
    page,
    () => page.goto(url)
  );

  sessions.set(sessionId, { context, page, lastUrl: urlNow });
  res.json({ sessionId, url: urlNow, html });
});
```

#### `/session/nav`

```js
app.post("/session/nav", async (req, res) => {
  const { sessionId, href } = req.body;
  const sess = sessions.get(sessionId);
  const { page, lastUrl } = sess;
  const baseUrl = lastUrl || page.url() || href;
  const targetUrl = new URL(href, baseUrl).toString();

  const { url, html } = await runActionWithAssets(
    sessionId,
    page,
    () => page.goto(targetUrl)
  );
  sess.lastUrl = url;
  res.json({ url, html });
});
```

#### `/session/submit`

```js
app.post("/session/submit", async (req, res) => {
  const { sessionId, fields } = req.body;
  const sess = sessions.get(sessionId);
  const { page, lastUrl } = sess;

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
      form.submit(); // настоящий POST внутри Playwright
    }, fields);

  const { url, html } = await runActionWithAssets(sessionId, page, action);
  sess.lastUrl = url;
  res.json({ url, html });
});
```

---

## Proxy UI (`bui-proxy-ui`)

### `proxy-ui/Dockerfile`

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/server.js"]
```

### `proxy-ui/package.json`

```json
{
  "name": "browser-ui-proxy-ui",
  "version": "0.1.0",
  "main": "src/server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "express": "^4.19.0",
    "cheerio": "^1.0.0-rc.12"
  }
}
```

### Сессии в proxy-ui

* Cookie `bui_sid`:

  * если нет — генерим `crypto.randomBytes(16)`;
  * выставляем `Set-Cookie: bui_sid=...; HttpOnly; SameSite=Lax; Path=/`.

* `sessions` (Map):

```js
sessions[bui_sid] = {
  rendererSessionId, // id сессии в renderer
  lastHtml,          // последний HTML-снимок
  lastUrl,           // последний URL Playwright
  createdAt
};
```

### Основные эндпоинты

#### `GET /` — начальная загрузка

* берём/создаём сессию по `bui_sid`;
* если `rendererSessionId` ещё нет:

  * вызываем `POST renderer /session/start { TARGET_URL }`;
  * сохраняем `rendererSessionId`, `lastHtml`, `lastUrl`;
* если `lastHtml` пустой — обновляем через `/session/nav`;
* прогоняем `lastHtml` через:

  * `rewriteHtml` (плагины),
  * `injectClientJs` (вставка `client.js` в `<body>`),
* отдаём HTML.

#### `POST /__act/nav` — навигация по ссылкам / GET-формам

* вызывается из инжекта при клике по ссылке или сабмите GET-формы;
* тело: `{ href }`, где `href` уже относительный `"/path?query#hash"`.

На сервере:

```js
app.post("/__act/nav", async (req, res) => {
  const { sid, data } = getOrCreateSession(req, res);
  const href = req.body?.href || "";
  if (!data.rendererSessionId) {
    const startRes = await rendererStart(TARGET_URL);
    data.rendererSessionId = startRes.sessionId;
    data.lastHtml = startRes.html;
    data.lastUrl = startRes.url;
  }
  const { url, html } = await rendererNav(data.rendererSessionId, href);
  data.lastHtml = html;
  data.lastUrl = url;

  const out = applyTransforms(html, req, data);
  res.type("text/html; charset=utf-8").send(out);
});
```

#### `POST /__act/submit` — POST-формы (капча, логин, walkthrough)

* вызывается из инжекта при сабмите `method=POST`;
* тело: `{ fields: { name: value, ... } }`.

На сервере:

```js
app.post("/__act/submit", async (req, res) => {
  const { sid, data } = getOrCreateSession(req, res);
  const fields = req.body?.fields || null;
  if (!fields || typeof fields !== "object") {
    return res.status(400).send("fields object is required");
  }

  if (!data.rendererSessionId) {
    const startRes = await rendererStart(TARGET_URL);
    data.rendererSessionId = startRes.sessionId;
    data.lastHtml = startRes.html;
    data.lastUrl = startRes.url;
  }

  const { url, html } = await rendererSubmit(
    data.rendererSessionId,
    fields
  );
  data.lastHtml = html;
  data.lastUrl = url;

  const out = applyTransforms(html, req, data);
  res.type("text/html; charset=utf-8").send(out);
});
```

Таким образом:

* пользователь → `/__act/submit` → proxy-ui → renderer `/session/submit` → **настоящий** `form.submit()` в Playwright;
* всё происходит в одной sессии браузера (cookie, капча, редиректы).

---

## Инжектируемый JS (`proxy-ui/src/injected/client.js`)

Функции:

* `toProxyRelative(href)`:

  * конвертирует любой URL (`http://proxy...onion/...`, `/path`, `?q=`) в вид `"/path?query#hash"`;
* `navigateViaProxy(href)`:

  * `POST /__act/nav { href: rel }`,
  * `document.open/write/close(newHtml);`
* `submitViaProxy(fields)`:

  * `POST /__act/submit { fields }`,
  * `document.open/write/close(newHtml);`

Перехват событий:

* `click` по `<a href="...">`:

  * игнорируем `#anchor` и `javascript:...`;
  * `preventDefault`;
  * `navigateViaProxy(href)`.
* `submit` формы:

  * собираем `FormData` в объект `fields`;
  * если `method="GET"`:

    * забиваем поля в query к action/currentPath → `navigateViaProxy(url)`;
  * если `method="POST"`:

    * отправляем `submitViaProxy(fields)`.

Плюс добавляется маленький бейдж:

```text
⚠ via browser-ui-proxy
```

в правый нижний угол, чтобы пользователь всегда видел, что работает через прокси.

---

## HTML-плагины

### Конфиг: `proxy-ui/src/plugins/config.json`

```json
{
  "htmlPlugins": [
    {
      "name": "append-to-title",
      "enabled": true,
      "options": {
        "suffix": " [BROWSER-UI-PROXY]"
      }
    }
  ]
}
```

### Движок: `proxy-ui/src/plugins/index.js`

* загружает конфиг;
* `require`-ит плагины из `./<name>.js`;
* для каждого HTML вызывает `plugin.process($, ctx)`.

Контекст:

```js
const ctx = {
  config,
  session, // объект сессии proxy-ui
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
```

Пример `append-to-title.js`:

```js
function process($, ctx) {
  const { options, logger, request } = ctx;
  const suffix = options.suffix || " [via proxy]";

  const $title = $("title");
  if (!$title.length) {
    logger.info(
      `[plugin:append-to-title] no <title> on ${request && request.url}`
    );
    return;
  }

  const old = $title.text();
  const next = old + suffix;
  $title.text(next);

  logger.info(
    `[plugin:append-to-title] patched <title> on ${
      request && request.url
    }: "${old}" -> "${next}"`
  );
}

module.exports = { process };
```

---

## Запуск и ресет стека

### Первый запуск

```bash
cd /home/kali/browser-ui-proxy

docker compose build
docker compose up -d
docker compose ps
```

Проверка:

* `docker compose logs -f tor`
* `docker compose logs -f renderer`
* `docker compose logs -f proxy-ui`

Локальный доступ:

```text
http://localhost:8081/
```

Tor Browser:

```bash
docker compose exec tor cat /var/lib/tor/bui-onion-proxy/hostname
```

→ открыть полученный `.onion` в Tor Browser.

### Полный ресет стека (когда Tor/сети шалят)

```bash
cd /home/kali/browser-ui-proxy

# остановить и удалить контейнеры, сети, анонимные volume'ы
docker compose down --volumes --remove-orphans

# убедиться, что tor/keys сохранены и с правильными правами
ls -l tor/keys
chmod 700 tor/keys
chmod 600 tor/keys/hs_ed25519_secret_key
chmod 644 tor/keys/hs_ed25519_public_key
chmod 644 tor/keys/hostname

# пересборка и запуск с нуля
docker compose build --no-cache
docker compose up -d
```

---

## Многопользовательский режим

Архитектура уже **поддерживает несколько пользователей параллельно**:

* У каждого клиента свой `bui_sid` (cookie);
* У каждого `bui_sid` — своя запись в `sessions[bui_sid]`;
* У каждой записи — свой `rendererSessionId`, а в renderer — свой `browserContext+page`.

То есть:

```text
user A: bui_sid=A → rendererSessionId=R1 → свой headless-браузер
user B: bui_sid=B → rendererSessionId=R2 → другой браузер
```

Они не мешают друг другу:

* свои cookie, свои капчи, свои логины, свой прогретый UI.

Для тяжёлой нагрузки можно:

* вынести сессии в Redis/БД;
* добавлять таймауты жизни контекстов;
* горизонтально масштабировать `renderer` и `proxy-ui`.

---

## Известные ограничения (в текущем состоянии)

* **Индикатор активности браузера (native spinner)**:

  * так как навигация происходит через `fetch + document.write()`, браузер считает это “AJAX” и **не крутит свой спиннер**;
  * мы сознательно не внедряем оверлей/спиннер, чтобы не мешать UI — пользователь должен понимать, что это именно инструмент для UI-тестов.

* **JS-логика, завязанная только на клиент**:

  * модалки/walkthrough, которые живут исключительно в DOM/`localStorage` и не ходят на сервер, могут вести себя чуть иначе, чем в реальном браузере;
  * мы синхронизируем **формы и переходы**, а не весь жизненный цикл DOM между снапшотами.

* **Загрузка тяжёлых страниц**:

  * из-за инлайна всех CSS и картинок первый запрос/переход может быть тяжелее по времени и размеру ответа;
  * зато результат — стабильный, полностью самодостаточный HTML-снапшот для анализа UI.

---

## Итоги

В текущем состоянии:

* capcha/логины/сложные формы проходят через `__act/submit → session/submit → form.submit()` в Playwright;
* UI (включая фон и картинки товаров) полностью рендерится через headless Chromium и инлайнится;
* весь трафик к таргетам идёт через один headless-браузер на сессию по Tor;
* пользователь взаимодействует только с `browser-ui-proxy`, не трогая таргет напрямую.

Этот README описывает **ровно то состояние**, в котором сейчас работает твой стек. Если что-то ещё доработаем, можно будет просто дописать соответствующий раздел.
