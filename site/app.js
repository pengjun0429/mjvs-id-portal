(() => {
  const input = document.querySelector("#id-number");
  const output = document.querySelector("#lookup-result");
  const lookupButton = document.querySelector("#lookup-button");
  const widgetContainer = document.querySelector("#turnstile-widget");

  if (!input || !output || !lookupButton || !widgetContainer) return;

  let lookupEnabled = false;
  let captchaToken = "";
  let turnstile = null;
  let widgetId = null;
  let checking = false;

  const clearResultClasses = () => {
    output.classList.remove("is-error", "is-valid", "is-loading");
  };

  const renderMessage = (message, kind = "info") => {
    clearResultClasses();
    if (kind === "error") output.classList.add("is-error");
    if (kind === "valid") output.classList.add("is-valid");
    if (kind === "loading") output.classList.add("is-loading");
    output.replaceChildren();

    const mark = document.createElement("span");
    mark.className = "result-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = kind === "valid" ? "✓" : kind === "error" ? "!" : "i";

    const text = document.createElement("p");
    text.textContent = message;
    output.append(mark, text);
  };

  const updateControls = () => {
    input.disabled = !lookupEnabled || checking;
    lookupButton.disabled = !lookupEnabled || checking || !captchaToken || !input.value.trim();
  };

  const loadTurnstile = (siteKey) => new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }

    const existing = document.querySelector("script[data-mjvs-turnstile]");
    const script = existing || document.createElement("script");
    const onLoad = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("widget_unavailable"));
    const onError = () => reject(new Error("widget_unavailable"));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.mjvsTurnstile = "true";
      document.head.append(script);
    }
  });

  const initialize = async () => {
    updateControls();
    try {
      const response = await fetch("/api/config", { method: "GET", credentials: "same-origin", cache: "no-store" });
      const config = response.ok ? await response.json() : null;
      if (!config?.lookupEnabled || typeof config.turnstileSiteKey !== "string" || !config.turnstileSiteKey) {
        renderMessage("名錄尚未啟用或安全設定未完成，目前無法確認任何 ID。", "error");
        return;
      }

      turnstile = await loadTurnstile(config.turnstileSiteKey);
      turnstile.ready(() => {
        widgetId = turnstile.render(widgetContainer, {
          sitekey: config.turnstileSiteKey,
          action: "mjvs_lookup",
          callback: (token) => {
            captchaToken = typeof token === "string" ? token : "";
            updateControls();
            if (captchaToken) renderMessage("安全驗證完成；輸入一個 ID 後即可查驗。", "info");
          },
          "expired-callback": () => {
            captchaToken = "";
            updateControls();
            renderMessage("安全驗證已過期，請重新完成驗證。", "error");
          },
          "error-callback": () => {
            captchaToken = "";
            lookupEnabled = false;
            updateControls();
            renderMessage("安全驗證暫時無法使用，現在不能確認 ID。", "error");
          },
        });
        lookupEnabled = true;
        updateControls();
      });
    } catch {
      lookupEnabled = false;
      updateControls();
      renderMessage("查驗服務尚未啟用或安全驗證無法載入，目前不能確認 ID。", "error");
    }
  };

  const checkId = async () => {
    const submitted = input.value.trim();
    if (!submitted) {
      renderMessage("請輸入一個 ID。不要輸入姓名、護照號碼或其他個人資料。", "error");
      input.focus();
      return;
    }
    if (!lookupEnabled || !captchaToken || checking) {
      renderMessage("名錄尚未啟用或安全驗證尚未完成，目前無法確認 ID。", "error");
      return;
    }

    const oneTimeToken = captchaToken;
    captchaToken = "";
    checking = true;
    updateControls();
    output.setAttribute("aria-busy", "true");
    renderMessage("正在查驗單筆 ID…", "loading");

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submitted, captchaToken: oneTimeToken }),
        credentials: "same-origin",
        cache: "no-store",
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (response.status === 503) {
        renderMessage("名錄尚未啟用或無法確認，目前不能核實此 ID。", "error");
        return;
      }
      if (response.status === 429) {
        renderMessage("查詢頻率已達限制，請稍後再試。", "error");
        return;
      }
      if (response.status === 403) {
        renderMessage("安全驗證未通過，請重新完成驗證後再試。", "error");
        return;
      }
      if (!response.ok) {
        renderMessage("查驗服務目前無法完成查詢，請稍後再試。", "error");
        return;
      }
      if (data?.valid === true) {
        renderMessage("此 ID 有效。實際免簽待遇仍須依目的地與個別生效互惠協議確認。", "valid");
        return;
      }
      if (data?.valid === false) {
        renderMessage("沒有在免簽名單之內。", "error");
        return;
      }
      renderMessage("查驗服務回覆不完整，暫時無法確認此 ID。", "error");
    } catch {
      renderMessage("查驗服務目前無法連線，尚不能確認此 ID。", "error");
    } finally {
      checking = false;
      output.setAttribute("aria-busy", "false");
      if (turnstile && widgetId !== null) {
        try { turnstile.reset(widgetId); } catch {}
      }
      updateControls();
    }
  };

  lookupButton.addEventListener("click", checkId);
  input.addEventListener("input", updateControls);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      checkId();
    }
  });

  initialize();
})();
