# MJVS 免簽 ID 申請與查驗入口

這是 MJVS 的公開網站入口，整理參與方申請、逐一互惠、兩種 ID 建立方式及單筆查驗流程。公開靜態資產只部署 `site/`；Pages Functions 位於專案根層 `functions/`。唯一查驗來源是使用者指定的 Google 試算表，本專案以 Google Visualization CSV query 只請求 A/E 兩欄，不使用 D1，也不將名錄資料複製進 Git repository。

**資料可見性：**目前試算表設定為「知道連結的人可以檢視」。CSV 包含 `id`、`country_name`、`registered_name`、`public_name_authorized`、`status` 五欄；任何取得連結的人都能直接下載整份表格。網站 API 只使用 ID 與 status 判斷，不回傳姓名或國家，但這不會讓來源試算表變成私密。不要把護照號碼、護照影像或其他未授權敏感資料放進這份表格。

網站流程依工作區提供的《MJVS_規章與流程.md》第 3 版草案整理。加入 MJVS 不會自動與所有參與方互免；至少一份有效互惠協議才可登記為免簽國，且協議範圍、目的、停留期限、生效日與例外依個別協議。若已無有效協議，該身分暫停。網站內容不等於規章已正式通過、外交承認或入境保證。

## 公開查驗的回覆範圍

`POST /api/lookup` 一次只接受一個 ID。名錄有效且 `status=active` 時只回覆有效；有至少一筆格式有效的記錄但 ID 不存在或狀態為 suspended/revoked 時，顯示「沒有在免簽名單之內」。CSV 沒有資料列、欄位或資料格式錯誤、上游讀取失敗、Turnstile／限流保護未就緒，或其他狀態無法核實時，一律回覆 503「名錄尚未啟用或無法確認」，不會把空白名錄誤報為查無。

後端以 Google Visualization CSV query `select A,E` 只請求 `id` 與 `status` 兩欄，因此不下載姓名、國家或其他欄位；回應、日誌、URL 與瀏覽器儲存空間也不包含個人資料。公開網站沒有列表、下載、批次查詢或管理端點。接受 `active`、`suspended`、`revoked` 狀態；重複 ID、欄位錯誤、不完整資料或超過 5,000 筆上限會 fail closed。ID 欄應設為純文字，避免前導零或長 ID 被試算表轉型。注意：一般公開 CSV 匯出連結仍可供任何連結持有者下載整份表格；本 API 僅對 Google 查詢端點選取 A/E 欄。

在本次部署前驗證的 A/E 兩欄 CSV query 回應為 HTTP 200、標頭為 `id,status`，但 **目前 0 筆名錄資料**。因此就算來源可讀，查驗仍須顯示「名錄尚未啟用／無法確認」。目前正式環境也尚未完成 Turnstile 與限流 Worker 綁定；功能預設關閉，不會對任何 ID 回覆有效或查無。

## 啟用前必須完成

1. 在官方試算表填入至少一筆真實且經核對的 ID/status 資料；ID 必須唯一，status 僅能為 `active`、`suspended` 或 `revoked`。因原始表格可由連結持有者完整讀取，本專案不會自行產生或提交真實資料。
2. 建立正式網域的 Cloudflare Turnstile widget，並在 Pages 設定 `TURNSTILE_SITE_KEY`（公開 site key）及 secret `TURNSTILE_SECRET_KEY`。伺服器驗證 Siteverify 成功、hostname 與 `mjvs_lookup` action。
3. 部署 `rate-limiter/` 中的 Durable Object Worker，並將它綁定至 Pages Function 名稱 `LOOKUP_RATE_LIMITER`；以隨機至少 32 字元 secret 設定 `LOOKUP_RATE_LIMIT_PEPPER`。限流器以 HMAC 後來源 IP key 限制每分鐘最多 10 次，不保存原始 IP。Pages 專案目前尚無此 binding；現有 PORTIFY token 僅 Pages Write，未具備部署／綁定 Worker 所需權限。
4. 完成前述資料與安全檢查後，才在 Cloudflare Pages 設定 `MJVS_PUBLIC_LOOKUP_ENABLED=true`。名錄為空、Turnstile／限流缺失或來源異常時，程式仍會 fail closed。

不要把真實 ID、名單或護照資料放入公開 GitHub repository、測試 fixture 或公開文件。若未來要讓整份名錄不再公開，需要將試算表改回私密，將本程式改為 Google Sheets API 的服務端唯讀授權，並同步修改資料讀取方式。

## 本機檢查與部署

```sh
node tests/lookup.test.mjs
node tests/rate-limiter.test.mjs
node --check site/app.js
node --input-type=module --check < functions/api/lookup.js
node --input-type=module --check < functions/api/config.js

# 靜態預覽
python3 -m http.server 8080 --directory site

# Pages Direct Upload：只部署本專案的 site/，不要部署工作目錄
npx wrangler pages deploy ./site --project-name mjvs-id-portal --branch main
```

Cloudflare Pages 專案採 Direct Upload、沒有連接 GitHub 自動部署。主分支 `main` 是 production branch；`mjvs-preview` 是 preview branch。Functions 由專案根層 `functions/` 配合 Pages 專案設定處理；`rate-limiter/` 是獨立 Worker source，不會被當成網站靜態資產部署。

## 官方技術文件

- [Cloudflare Turnstile client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/) 與 [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) — 每次 token 都需伺服器端驗證；token 單次使用且 5 分鐘到期。
- [Cloudflare Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/) 與 [Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) — Pages Function 綁定與設定參考。
- [Cloudflare Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — Worker Runtime 的限制說明；Pages Functions bindings 清單未提供原生 Rate Limiting binding，因此本專案使用獨立 Durable Object。
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — Turnstile secret 與限流 pepper 只存 Cloudflare secret，不進公開原始碼。
