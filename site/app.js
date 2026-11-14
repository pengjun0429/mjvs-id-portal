(() => {
  const input = document.querySelector("#id-number");
  const output = document.querySelector("#lookup-result");
  const lookupButton = document.querySelector("#lookup-button");
  const serviceStatus = document.querySelector("#service-status-headline");
  const lookupHelp = document.querySelector("#lookup-help");

  if (!input || !output || !lookupButton) return;

  let lookupEnabled = false;
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
    lookupButton.disabled = !lookupEnabled || checking || !input.value.trim();
  };

  const showNotReady = (message) => {
    lookupEnabled = false;
    updateControls();
    if (serviceStatus) serviceStatus.textContent = message;
    if (lookupHelp) lookupHelp.textContent = `${message} 請勿輸入姓名、護照號碼或其他個人資料。`;
    renderMessage(message, "error");
  };

  const initialize = async () => {
    updateControls();
    try {
      const response = await fetch("/api/config", { method: "GET", credentials: "same-origin", cache: "no-store" });
      const config = response.ok ? await response.json() : null;
      if (!config?.lookupEnabled) {
        showNotReady(config?.message || "名錄尚未啟用或無法確認，目前不能查驗。");
        return;
      }

      lookupEnabled = true;
      updateControls();
      if (serviceStatus) serviceStatus.textContent = "查驗服務已啟用。";
      if (lookupHelp) lookupHelp.textContent = "輸入一個 ID 即可查驗。請勿輸入姓名、護照號碼或其他個人資料。";
      renderMessage(config.message || "名錄已啟用，可以查驗單筆 ID。", "info");
    } catch {
      showNotReady("名錄目前無法讀取，暫時不能確認 ID。");
    }
  };

  const checkId = async () => {
    const submitted = input.value.trim();
    if (!submitted) {
      renderMessage("請輸入一個 ID。不要輸入姓名、護照號碼或其他個人資料。", "error");
      input.focus();
      return;
    }
    if (!lookupEnabled || checking) {
      renderMessage("名錄尚未啟用或無法確認，目前不能查驗 ID。", "error");
      return;
    }

    checking = true;
    updateControls();
    output.setAttribute("aria-busy", "true");
    renderMessage("正在查驗單筆 ID…", "loading");

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submitted }),
        credentials: "same-origin",
        cache: "no-store",
      });
      let data;
      try { data = await response.json(); } catch { data = null; }

      if (response.status === 503) {
        showNotReady(data?.message || "名錄尚未啟用或無法確認，目前不能核實此 ID。");
        return;
      }
      if (response.status === 403) {
        renderMessage("查驗要求未獲接受，請重新載入網站後再試。", "error");
        return;
      }
      if (!response.ok) {
        renderMessage("查驗服務目前無法完成查詢，請稍後再試。", "error");
        return;
      }
      if (data?.valid === true) {
        const country = typeof data.country === "string" ? data.country.trim() : "";
        if (!country) {
          renderMessage("查驗結果缺少所屬國家，暫時無法確認。", "error");
          return;
        }
        renderMessage(`此 ID 有效。所屬國家：${country}`, "valid");
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
