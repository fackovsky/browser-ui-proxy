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

  async function navigateViaProxy(href) {
    const rel = toProxyRelative(href);

    try {
      const resp = await fetch("/__act/nav", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ href: rel })
      });

      if (!resp.ok) {
        console.error("Proxy nav failed with status", resp.status);
        return;
      }

      const html = await resp.text();
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      console.error("Proxy nav error", e);
    }
  }

  async function submitViaProxy(fields) {
    try {
      const resp = await fetch("/__act/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ fields })
      });

      if (!resp.ok) {
        console.error("Proxy submit failed with status", resp.status);
        return;
      }

      const html = await resp.text();
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      console.error("Proxy submit error", e);
    }
  }

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
      navigateViaProxy(href);
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
          // Классический поиск: параметры в query
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

          navigateViaProxy(url.toString());
        } else {
          // method=POST (наш случай с капчой) — отправляем поля на /__act/submit
          submitViaProxy(fields);
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
      badge.style.zIndex = "999999";
      badge.style.pointerEvents = "none";
      document.body.appendChild(badge);
    } catch (e) {
      console.error("badge error", e);
    }
  });
})();
