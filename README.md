# MJVS 免簽 ID 申請與查驗網站

本站依《聯合微國家免簽中心組織規章》第 3 版草案延續製作，保留參與方申請、逐一互惠、個人 ID 申請／名單發放說明、公開查驗及協議原則等既有頁面。靜態網站位於 `site/`；Pages Function 位於專案根層 `functions/`；D1 schema migration 位於 `migrations/`，不會部署成公開靜態檔案。

## 查驗回覆

`POST /api/lookup` 接收單一 ID。若名錄已啟用，且找到有效、已授權公開姓名的記錄，只回傳 `country` 與 `registeredName`；查無記錄時回傳「沒有在免簽名單之內」。不提供姓名或國家搜尋、不提供批次／名單 endpoint，亦不回傳護照或原始 ID。

ID 先以伺服器端 `ID_LOOKUP_PEPPER` 做 HMAC-SHA-256，再以摘要查詢；資料庫不保存原始 ID。個人 ID 查驗頁不把 ID 放入 URL，使用同源 POST、`Cache-Control: no-store`，前端以 `textContent` 顯示姓名，避免把資料當 HTML 執行。只有 `public_name_authorized=1` 的資料才會回傳姓名與國家。

資料表初始的 `registry_control.is_ready` 為 `0`。未建立／綁定 D1、金鑰缺少、尚未完成資料匯入或資料庫故障時，API 回傳 503「名錄尚未啟用／無法確認」，不會把空名錄誤報為「沒有在免簽名單之內」。只有完成資料匯入、對帳及啟用程序後，管理者才應把名錄標記為 ready。

預設示範碼 `DEMO-ONLY-NOT-VALID` 是虛構且明確無效的；它只在瀏覽器顯示「沒有在免簽名單之內」的示範結果，不會送到 API，也不代表任何實際 ID、國家或協議。網站目前沒有任何真實 ID、姓名或護照資料。

## 正式啟用前需要完成

目前 PORTIFY 帳戶沒有 MJVS D1 資料庫，因此正式名錄不能查詢。需先建立 PORTIFY 專用 D1 並套用 `migrations/0001_id_registry.sql`，把名為 `DB` 的 D1 binding 設給 Pages Function 的 preview 與 production 環境，並以 Pages secret 設定隨機 `ID_LOOKUP_PEPPER`。現有 Cloudflare 憑證只授予 PORTIFY Pages Write，不能建立或寫入 D1；`fumo_cloudflare_d1_token` 只供 FUMO 帳戶，不可挪用。建立資料庫／執行 migration 需另有僅授予 PORTIFY D1 Edit／Write 的權限。

建立 D1 前還需要確認資料儲存區域；台灣使用者可先考慮 APAC 作為主要位置提示，但這不等於嚴格資料在地化保證。還需由 MJVS 提供可透過安全私密管道匯入的正式資料，每筆至少含 ID、國家、註冊姓名、狀態及姓名可公開查驗的授權；不要把名單提交到公開 GitHub repo。ID 應使用高熵、不可順序猜測的識別碼，並在啟用公開查驗前配置 API 速率限制及防列舉措施。本站尚未實作管理員登入或名單匯入介面，亦未設定正式維運、稽核與資料保留政策。

免簽適用仍須依來源國、目的地、旅行目的、日期、有效協議與例外個別判斷；查到有效 ID 不代表有互惠安排，也不保證個案一定獲准入境。此網站不代表規章草案已正式通過。

## 本機檢查與部署

靜態頁面可用 `python3 -m http.server 8080 --directory site` 預覽。Pages Functions 需要 Wrangler Pages runtime；部署前需在本機有對應的 Cloudflare 憑證。

```sh
node tests/lookup.test.mjs
npx wrangler pages deploy ./site --project-name mjvs-id-portal --branch mjvs-preview
```

Cloudflare Pages 專案採 Direct Upload，沒有連接 GitHub 自動部署；每次更新需重新部署。只部署 `site/` 靜態目錄，Functions 會從專案根層 `functions/` 讀取，`migrations/` 不會公開。

## 規章參考

依工作區提供的《MJVS_規章與流程.md》第 3 版草案：第二章（第 3–4 條）、第四章（第 7–9 條）、第五章（第 10–11 條）、第六章（第 12–13 條）及附錄一、附錄二。
