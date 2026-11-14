(() => {
  const input = document.querySelector("#id-number");
  const output = document.querySelector("#lookup-result");
  const exampleButton = document.querySelector("#fill-example");
  const lookupButton = document.querySelector("#lookup-button");
  const exampleId = "DEMO-ONLY-NOT-VALID";

  if (!input || !output || !exampleButton || !lookupButton) return;

  const clearResultClasses = () => {
    output.classList.remove("is-example", "is-error", "is-record", "is-loading");
  };

  const renderMessage = (message, kind = "info") => {
    clearResultClasses();
    if (kind === "warning") output.classList.add("is-example");
    if (kind === "error") output.classList.add("is-error");
    if (kind === "loading") output.classList.add("is-loading");
    output.replaceChildren();

    const mark = document.createElement("span");
    mark.className = "result-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = kind === "warning" || kind === "error" ? "!" : "i";

    const text = document.createElement("p");
    text.textContent = message;
    output.append(mark, text);
  };

  const renderRecord = ({ country, registeredName }) => {
    clearResultClasses();
    output.classList.add("is-record");
    output.replaceChildren();

    const mark = document.createElement("span");
    mark.className = "result-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✓";

    const content = document.createElement("div");
    content.className = "lookup-record";

    const heading = document.createElement("p");
    heading.className = "lookup-result-heading";
    heading.textContent = "查驗結果：此 ID 在已啟用名錄中。";

    const fields = document.createElement("dl");
    fields.className = "lookup-fields";
    for (const [label, value] of [["國家", country], ["註冊姓名", registeredName]]) {
      const field = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = value;
      field.append(term, detail);
      fields.append(field);
    }

    content.append(heading, fields);
    output.append(mark, content);
  };

  exampleButton.addEventListener("click", () => {
    input.value = exampleId;
    input.focus();
  });

  const checkId = async () => {
    const submitted = input.value.trim();

    if (!submitted) {
      renderMessage("請輸入個人 ID。不要輸入姓名、護照號碼或其他個人資料。", "error");
      input.focus();
      return;
    }

    if (submitted.normalize("NFKC").toUpperCase() === exampleId) {
      renderMessage("沒有在免簽名單之內。此代碼是明確標示為無效的虛構示範碼，結果不具正式效力。", "warning");
      return;
    }

    lookupButton.disabled = true;
    output.setAttribute("aria-busy", "true");
    renderMessage("正在向 MJVS 查驗單筆 ID…", "loading");

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submitted }),
        credentials: "same-origin",
        cache: "no-store",
      });

      let data;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      const unavailableCodes = ["registry_not_ready", "registry_unavailable", "record_not_ready", "lookup_unavailable"];
      if (response.status === 503 && unavailableCodes.includes(data?.error)) {
        renderMessage("正式名錄尚未啟用或尚未完成設定，目前無法確認此 ID 是否在免簽名單內。", "error");
        return;
      }

      if (!response.ok) {
        renderMessage("查驗服務目前無法完成查詢，請稍後再試。", "error");
        return;
      }

      if (data?.found === false) {
        renderMessage("沒有在免簽名單之內。", "warning");
        return;
      }

      if (data?.found === true && typeof data.country === "string" && data.country && typeof data.registeredName === "string" && data.registeredName) {
        renderRecord(data);
        return;
      }

      renderMessage("查驗服務回覆格式不完整，暫時無法確認此 ID。", "error");
    } catch {
      renderMessage("正式查驗服務目前無法連線，尚不能確認此 ID 是否在名單內。", "error");
    } finally {
      lookupButton.disabled = false;
      output.setAttribute("aria-busy", "false");
    }
  };

  lookupButton.addEventListener("click", checkId);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      checkId();
    }
  });
})();
