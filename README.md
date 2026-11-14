# MJVS ID 有效性查驗

本 repository 提供 MJVS 公開單筆 ID 查驗。靜態資產只部署 `site/`；Cloudflare Pages Functions 位於 `functions/`。名錄只取自指定 Google 試算表，不使用 D1，也不把名錄資料複製到 Git repository。

## 名錄欄位與查驗

正式名錄使用三欄，順序為 `id`、`country_name`、`status`。後端只請求試算表 A:C，不讀取其他欄位。來源 Sheet 對持有連結者公開檢視；國家欄會供有效 ID 的查驗結果顯示，請勿加入姓名、護照或其他不應公開的資料。

目前查詢來源：

`https://docs.google.com/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq?tqx=out:csv&gid=1037470539&tq=select%20A%2CB%2CC`

欄位規則：

- `id`：每筆唯一 ID；建議設為純文字，避免前導零或長 ID 被試算表轉型。
- `country_name`：該 ID 所屬國家之確認後顯示名稱；不可猜測，空白時不啟用查驗。
- `status`：只接受 `active`、`suspended`、`revoked`。

`GET /api/config` 會即時確認 CSV 標頭、資料格式，以及是否至少有一筆完整資料。空表或任何列缺少必要欄位時，查驗停用並回覆「名錄尚未啟用」或「名錄資料不完整／無法確認」，不會當作查無。`POST /api/lookup` 一次只接受一個 ID：只有 `active` 且有國家的記錄會回覆 `{ valid: true, message: "此 ID 有效。", country }`；回應不含原始 ID 或姓名。不存在、`suspended` 或 `revoked` 回覆「沒有在免簽名單之內」。

依使用者指示，查驗不使用 Turnstile、captcha、rate limiter 或 pepper；公開 API 可被重複請求。網站不提供名錄列表、下載或批次查詢端點。

缺少 `country_name` 或 `status` 時，整份名錄會保持無法確認；系統不回傳空國家、不推定國家，也不把不完整資料誤報為查無。自動化測試只使用合成測試 ID 與測試國家，不以真實 ID 測試。

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
