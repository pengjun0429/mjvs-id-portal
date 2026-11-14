(() => {
  const input = document.querySelector("#id-number");
  const output = document.querySelector("#lookup-result");
  const exampleButton = document.querySelector("#fill-example");
  const lookupButton = document.querySelector("#lookup-button");
  const exampleId = "DEMO-ONLY-NOT-VALID";

  if (!input || !output || !exampleButton || !lookupButton) return;

  const render = (message, isExample = false) => {
    output.classList.toggle("is-example", isExample);
    output.replaceChildren();
    const mark = document.createElement("span");
    mark.className = "result-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = isExample ? "!" : "i";
    const text = document.createElement("p");
    text.textContent = message;
    output.append(mark, text);
  };

  exampleButton.addEventListener("click", () => {
    input.value = exampleId;
    input.focus();
  });

  const checkExample = () => {
    const submitted = input.value.trim().toUpperCase();

    if (!submitted) {
      render("請輸入示範 ID。不要輸入姓名、護照號碼或其他個人資料。");
      input.focus();
      return;
    }

    if (submitted === exampleId) {
      render("示範記錄：DEMO-ONLY-NOT-VALID。此代碼是虛構示意，明確標記為無效；來源參與方、目的地及協議均未設定，不代表任何有效 ID 或現行免簽安排。此結果只在本機頁面生成，沒有連接資料庫。", true);
      return;
    }

    render("本示範網站沒有連接正式登記資料庫，無法確認此 ID 是否存在或有效。請勿將此訊息當成正式查驗結果；查詢內容未傳送或保存。");
  };

  lookupButton.addEventListener("click", checkExample);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      checkExample();
    }
  });
})();
