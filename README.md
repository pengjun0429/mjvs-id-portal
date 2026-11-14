# MJVS ID 有效性查驗

本 repository 專門提供 MJVS 公開單筆 ID 查驗。靜態資產只部署 `site/`；Cloudflare Pages Functions 位於 `functions/`。名錄只取自指定 Google 試算表，本服務不使用 D1，也不把名錄資料複製到 Git repository。

## 名錄欄位與查驗

正式名錄只使用兩欄：`id`、`status`。後端透過 Google Visualization CSV query 只請求 A/B，不讀取其他欄位。來源 Sheet 設為「知道連結的人可以檢視」；任何知道連結的人仍可檢視整份表格，所以請勿加入姓名、國家、護照或其他個人資料。

目前查詢來源：

`https://docs.google.com/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq?tqx=out:csv&gid=1037470539&tq=select%20A%2CB`

欄位規則：

- `id`：每筆唯一 ID；建議設為純文字，避免前導零或長 ID 被試算表轉型。
- `status`：只接受 `active`、`suspended`、`revoked`。

`GET /api/config` 即時確認 CSV 標頭、資料格式與是否至少有一筆資料。空表時頁面顯示「名錄尚未啟用（目前沒有任何 ID 記錄）」並停用查驗；來源有有效資料後自動啟用，不需手動旗標或 secret。`POST /api/lookup` 一次只接受一個 ID：`active` 回覆「此 ID 有效」；不存在、`suspended` 或 `revoked` 回覆「沒有在免簽名單之內」。空表、格式錯誤或 Google 暫時無法讀取時，回覆 503「名錄尚未啟用／無法確認」，不會把空白名錄誤報為查無。

依使用者指示，查驗不使用 Turnstile、captcha、rate limiter 或 pepper；公開 API 可被重複請求。網站不提供名錄列表、下載或批次查詢端點，不回傳 ID 或其他欄位值；查驗結果只陳述名錄狀態。

截至本次更新，名錄有一筆 ID 資料列，但該列的 `status` 尚未填寫。網站因此會顯示「名錄格式無法確認」，並保持查驗停用；不會推定該 ID 有效或查無。填入 `active`、`suspended` 或 `revoked` 後才可依狀態查驗。測試中的 ID 均為假資料。

## 開發與部署

```sh
node tests/lookup.test.mjs
node --check site/app.js
node --input-type=module --check < functions/api/lookup.js
node --input-type=module --check < functions/api/config.js
node --check functions/lib/registry.mjs

# 靜態預覽
python3 -m http.server 8080 --directory site

# Cloudflare Pages Direct Upload：僅部署專用 site/，不可部署工作目錄
npx wrangler pages deploy ./site --project-name mjvs-id-portal --branch main
```

Pages 專案使用 Direct Upload，沒有連接 GitHub 自動部署；`main` 為 production branch，`mjvs-preview` 為 preview branch。Functions 由根目錄 `functions/` 打包。
