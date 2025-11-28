````markdown
# browser-ui-proxy (bui)

“Удалённый браузер” поверх Tor:  
под капотом крутится настоящий Chromium (Playwright + Tor),  
а пользователю отдаётся только **HTML-снимок** страницы с нашими инжектами и плагинами.

Ключевая идея:

> Клиент **никогда не ходит** к таргету напрямую.  
> Все запросы к сайту делает только headless-браузер.  
> Пользователь видит только результат (HTML) и взаимодействует через прокси.

---

## Архитектура

Проект состоит из трёх сервисов:

- **`bui-tor`** — Tor в Docker:
  - SOCKS-прокси `socks5://tor:9050` для Playwright;
  - опционально: `.onion` hidden service для `bui-proxy-ui`.

- **`bui-renderer`** (`renderer/`) — headless Chromium:
  - поднимает один экземпляр браузера (Playwright);
  - через Tor открывает страницы (`TARGET_URL` и навигацию по ссылкам/формам);
  - собирает CSS и картинки и **инлайнит** их в HTML (через `<style>` и `data:` URI);
  - API:
    - `POST /session/start { url }` → запускает новую сессию, возвращает `{ sessionId, url, html }`;
    - `POST /session/nav { sessionId, href }` → навигация внутри сессии, возвращает `{ url, html }`.

- **`bui-proxy-ui`** (`proxy-ui/`) — фронтовый HTTP-прокси:
  - принимает запросы от браузера пользователя;
  - ведёт свои сессии по cookie `bui_sid`;
  - для каждой сессии создаёт **одну** Playwright-сессию (`rendererSessionId`);
  - отдаёт пользователю HTML, модифицированный плагинами и с инжектированным JS;
  - JS на стороне клиента перехватывает клики/формы и отправляет действия обратно в `bui-proxy-ui` → `bui-renderer`.

Схема:

```text
Браузер пользователя ── HTTP ──> bui-proxy-ui ──HTTP/JSON──> bui-renderer ──> Tor ──> .onion/.web
       ↑                           ↑
       |                           |
    инжектируемый JS           плагины (Cheerio)
````

---

## Структура проекта

```text
browser-ui-proxy/
  docker-compose.yml

  tor/
    Dockerfile
    torrc
    keys/                      # здесь ваши hs_ed25519_* и hostname (если есть)

  renderer/
    Dockerfile
    package.json
    src/
      server.js                # API: /session/start, /session/nav

  proxy-ui/
    Dockerfile
    package.json
    src/
      server.js                # основной HTTP-сервер для клиента
      plugins/
        index.js               # движок плагинов (Cheerio)
        config.json            # настройка плагинов
        append-to-title.js     # пример плагина
      injected/
        client.js              # JS, который инжектится на страницу
```

---

## docker-compose

Полный `docker-compose.yml`:

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
      # Здесь лежат ваши готовые ключи hidden service
      # tor/keys/hs_ed25519_secret_key
      # tor/keys/hs_ed25519_public_key
      # tor/keys/hostname
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
      # Стартовая страница, которую будет открывать Playwright
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

## Tor и hidden service (`bui-tor`)

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

# Hidden service для нашего browser-ui-proxy
HiddenServiceDir /var/lib/tor/bui-onion-proxy
HiddenServiceVersion 3
HiddenServicePort 80 bui-proxy-ui:8080
```

### Ключи hidden service

Если у вас уже есть готовый `.onion` (например, начинающийся с `proxy...`):

* положите в `tor/keys` в корне проекта три файла:

  ```text
  tor/keys/
    hs_ed25519_secret_key
    hs_ed25519_public_key
    hostname
  ```

* выставьте права:

  ```bash
  chmod 700 tor/keys
  chmod 600 tor/keys/hs_ed25519_secret_key
  chmod 644 tor/keys/hs_ed25519_public_key
  chmod 644 tor/keys/hostname
  ```

После запуска:

```bash
docker compose up -d tor
docker compose exec tor cat /var/lib/tor/bui-onion-proxy/hostname
```

Вы увидите свой `.onion`-адрес proxy — именно его будут использовать пользователи в Tor Browser.

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
    "playwright": "1.47.0"
  }
}
```

### Логика renderer

* Один глобальный Chromium (Playwright);
* `sessions` (Map): `sessionId -> { context, page, lastUrl }`;
* API:

  * `POST /session/start { url }`:

    * создаёт `browserContext` + `page`;
    * делает `page.goto(url, { waitUntil: "networkidle" })`;
    * слушает все `response`:

      * для `text/css` собирает CSS;
      * для картинок (`image/*`) собирает `body()` и конвертирует в base64;
    * переписывает `url(...)` внутри CSS на `data:image/...;base64,...` (если картинка есть);
    * инлайнит CSS в `<style>` в `<head>`;
    * возвращает `{ sessionId, url, html }`.

  * `POST /session/nav { sessionId, href }`:

    * находит `sessionId`;
    * строит новый URL относительно `lastUrl`;
    * делает тот же `gotoWithInlineCssAndImages`;
    * возвращает `{ url, html }`.

Рендерер **полностью сам** ходит по Tor к таргету, загружает CSS и картинки и отдаёт уже собранный HTML.

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

* cookie `bui_sid`:

  * если нет — генерится `crypto.randomBytes(16).toString("hex")`;
  * выдаётся через `Set-Cookie: bui_sid=...; HttpOnly; SameSite=Lax; Path=/`.

* `sessions` (Map):

  ```js
  sessions[bui_sid] = {
    rendererSessionId,  // id сессии в renderer
    lastHtml,           // последний HTML
    lastUrl,            // последний URL в Playwright
    createdAt
  };
  ```

### Входная точка `/` (GET)

* Находит или создаёт сессию по `bui_sid`.
* Если `rendererSessionId` ещё нет:

  * вызывает `renderer /session/start { TARGET_URL }`;
  * сохраняет `rendererSessionId`, `lastHtml`, `lastUrl`.
* Берёт текущий `lastHtml`, прогоняет через:

  * `rewriteHtml` (плагины),
  * `injectClientJs` (вставка `client.js` в `<body>`),
* отдаёт HTML пользователю.

### Навигация `/__act/nav` (POST)

Инжектируемый JS перехватывает клики по ссылкам и отправляет:

```json
POST /__act/nav
{ "href": "/path?query" }
```

* proxy-ui:

  * по `bui_sid` находит `rendererSessionId`;
  * вызывает `renderer /session/nav { sessionId, href }`;
  * получает `{ url, html }`;
  * сохраняет `lastHtml`, `lastUrl`;
  * прогоняет через плагины и инъекцию;
  * возвращает HTML.

На клиенте:

* `client.js` делает:

  ```js
  document.open();
  document.write(newHtml);
  document.close();
  ```

→ Страница полностью “перерисовывается” на свежий снимок из Playwright.

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

* Загружает `config.json`;

* `require`-ит плагины из `./<name>.js`;

* Для каждого HTML-ответа вызывает `plugin.process($, ctx)`:

  ```js
  const ctx = {
    config,        // общий конфиг (пока не используем)
    session,       // объект сессии proxy-ui
    logger,        // { info, error }
    request: {     // данные запроса к proxy-ui
      url,
      method,
      headers
    }
  };
  ```

* `process($, ctx)` работает через Cheerio (`$` — jQuery-подобный объект).

Пример плагина `append-to-title.js`:

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

## Инжектируемый JS: `proxy-ui/src/injected/client.js`

Функции:

* перехватывает клики по `<a href="...">`:

  * игнорирует `href="#"`, `javascript:...`;
  * делает `preventDefault()` и вызывает `/__act/nav`.

* перехватывает submit форм:

  * собирает `FormData`;
  * пока все формы (и GET, и POST) конвертируются в GET с query-параметрами и тоже идут через `/__act/nav`;
  * это временное упрощение прототипа.

* рисует маленький бейдж в углу (`⚠ via browser-ui-proxy`), чтобы пользователь видел, что страница идёт через прокси.

---

## Как запускать

```bash
cd browser-ui-proxy

docker compose build
docker compose up -d

docker compose ps
docker compose logs -f proxy-ui
docker compose logs -f renderer
docker compose logs -f bui-tor
```

### Проверка локально

Открой:

* `http://localhost:8081/`

Должно быть:

* грузится стартовая страница (`TARGET_URL`), но через Playwright+Tor;
* в `<title>` добавляется `[BROWSER-UI-PROXY]`;
* в правом нижнем углу — бейдж;
* клики по ссылкам и простые GET-формы работают (навигация идёт через proxy-ui → renderer).

### Проверка через Tor

Если настроен hidden service (и ключи в `tor/keys` валидны):

```bash
docker compose exec tor cat /var/lib/tor/bui-onion-proxy/hostname
```

Полученный `.onion` можно открыть в Tor Browser:

* адрес будет начинаться, например, с `proxy...onion` (если такие ключи были изначально);
* внутри — тот же UI, что и через `localhost:8081`, но уже как скрытый сервис.

---

## Многопользовательский режим

Архитектура из коробки поддерживает **много пользователей**:

* У каждого клиента:

  * свой `bui_sid` (cookie),
  * своя запись в `sessions` (proxy-ui),
  * свой `rendererSessionId` → отдельный Playwright `context + page`.

Т.е.:

```text
user A: bui_sid=A → rendererSessionId=RA → свой браузер
user B: bui_sid=B → rendererSessionId=RB → другой браузер
```

Они не мешают друг другу:

* разные cookie, разные цепочки Tor, разные капчи и т.д.

Для продакшена можно:

* вынести сессии в внешнее хранилище (Redis/PostgreSQL);
* ограничить время жизни сессий (закрывать старые `rendererSessionId`);
* масштабировать `renderer` горизонтально (несколько инстансов за балансировщиком).

---

## Ограничения и TODO

На текущий момент:

* Формы:

  * любые формы (GET/POST) сейчас **преобразуются в GET** с query-параметрами;
  * нужно будет добавить полноценный endpoint `/__act/submit` + соответствующий метод `/session/submit` в renderer, чтобы честно эмулировать POST внутри Playwright.

* JS сайта:

  * В браузер пользователя попадает ровно тот HTML, который вернул Playwright (с нашим плагинным патчем);
  * JS сайта внутри HTML исполняется у клиента (плюс наш инжект);
  * при необходимости можно добавить дополнительные защиты (перехват `window.location`, логирование/торможение некоторых действий).

* Сессии:

  * сейчас сессии хранятся в памяти процесса `proxy-ui`;
  * при рестарте контейнера сессии теряются.

Планы на будущее:

* добавить полноценную поддержку POST-форм через отдельный API до renderer;
* добавить PostgreSQL/Redis для аналитики и персистентных сессий;
* накидать больше HTML-плагинов (модификация блоков интерфейса, скрытие элементов, тестовые баннеры и т.п.);
* добавить лимит редиректов и дружелюбные сообщения пользователю, если сайт крутит бесконечные 302.

---

## Итог

`browser-ui-proxy` в текущем состоянии — это уже:

* настоящий **“browser-as-a-proxy”** движок:

  * вся логика сайта (капчи, редиректы, shop2go, JS) отрабатывает внутри Playwright;
  * пользователь видит только HTML+CSS+картинки, отрендеренные внутри headless-браузера;
* платформа для:

  * UI-тестирования,
  * экспериментов с HTML-плагинами,
  * аналитики пользовательских действий (клики/формы),
  * аккуратного проксирования сложных .onion/.web сайтов.

Дальше его можно только наращивать: больше плагинов, больше аналитики и умной логики поверх уже стабильного ядра.

```
::contentReference[oaicite:0]{index=0}
```
