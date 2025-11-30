// proxy-ui/src/injected/client.js
(function () {
  // Превращаем любой href в "прокси-относительный" путь: /path?query#hash
  function toProxyRelative(href) {
    if (!href) return "/";
    try {
      const u = new URL(href, window.location.href);
      const path = u.pathname || "/";
      const search = u.search || "";
      const hash = u.hash || "";
      return path + search + hash;
    } catch (e) {
      console.warn("toProxyRelative error", e);
      return href;
    }
  }

  // --- навигация через полноценный переход страницы ---

  function navFullPage(href) {
    const rel = toProxyRelative(href);
    // идём на наш спец-эндпоинт, который отдаёт уже готовый HTML
    const url = "/__act/nav?href=" + encodeURIComponent(rel);
    window.location.href = url;
  }

  function submitFullPage(fields) {
    // отправляем форму на /__act/submit обычным POST-запросом
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/__act/submit";

    Object.entries(fields).forEach(([key, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    });

    document.body.appendChild(form);
    form.submit();
  }

  // --- перехват событий ---

  // Перехват кликов по ссылкам
  document.addEventListener(
    "click",
    function (e) {
      let el = e.target;
      if (el && typeof el.closest === "function") {
        el = el.closest("a[href]");
      }
      if (!el) return;

      const href = el.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      if (href.toLowerCase().startsWith("javascript:")) return;

      e.preventDefault();
      navFullPage(href);
    },
    true
  );

  // Перехват отправки форм
  document.addEventListener(
    "submit",
    function (e) {
      const form = e.target;
      if (!form || !form.tagName || form.tagName.toLowerCase() !== "form") {
        return;
      }

      e.preventDefault();

      try {
        const formData = new FormData(form);
        const method = (form.getAttribute("method") || "GET").toUpperCase();
        const actionAttr = form.getAttribute("action");

        // Собираем поля в объект
        const fields = {};
        formData.forEach((value, key) => {
          fields[key] = value;
        });

        if (method === "GET") {
          const basePath =
            actionAttr && actionAttr.trim().length > 0
              ? actionAttr
              : window.location.pathname +
                window.location.search +
                window.location.hash;

          const url = new URL(basePath, window.location.href);
          Object.entries(fields).forEach(([key, value]) => {
            url.searchParams.set(key, value);
          });

          navFullPage(url.toString());
        } else {
          // method=POST (капчи, логин, walkthrough)
          submitFullPage(fields);
        }
      } catch (err) {
        console.error("submit interception error", err);
      }
    },
    true
  );

  // маленький бейдж в углу
  document.addEventListener("DOMContentLoaded", function () {
    try {
      const badge = document.createElement("div");
      badge.textContent = "⚠ via browser-ui-proxy";
      badge.style.position = "fixed";
      badge.style.right = "8px";
      badge.style.bottom = "8px";
      badge.style.fontSize = "12px";
      badge.style.background = "rgba(0,0,0,0.7)";
      badge.style.color = "#fff";
      badge.style.padding = "4px 8px";
      badge.style.borderRadius = "4px";
      badge.style.zIndex = "999998";
      badge.style.pointerEvents = "none";
      document.body.appendChild(badge);
    } catch (e) {
      console.error("badge error", e);
    }
  });
})();
