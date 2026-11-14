# MJVS 免簽 ID 申請與查驗入口

這是 MJVS 的公開網站入口，整理參與方申請、逐一互惠、兩種 ID 建立方式及單筆查驗流程。公開靜態資產只部署 `site/`；Pages Functions 位於專案根層 `functions/`。唯一權威名錄是 MJVS 管理的私密 Google 試算表；本專案不使用 D1，也不把試算表或名單提交至公開 repository。

網站流程依工作區提供的《MJVS_規章與流程.md》第 3 版草案整理。加入 MJVS 不會自動與所有參與方互免；至少一份有效互惠協議才可登記為免簽國，且協議範圍、目的、停留期限、生效日與例外依個別協議。若已無有效協議，該身分暫停。網站內容不等於規章已正式通過、外交承認或入境保證。

## 公開查驗的回覆範圍

`POST /api/lookup` 一次只接受一個 ID。啟用後只回覆該 ID 是否有效；查無有效記錄時顯示「沒有在免簽名單之內」。名錄未啟用、空白、欄位錯誤、權限不足或任何上游服務故障時，一律回覆 503「名錄尚未啟用或無法確認」，不會將無法確認誤報成查無。

後端只向私密試算表讀取 `名錄!A`（`id`）與 `名錄!E`（`status`）兩欄；不讀取姓名、國家或其他欄位，也不將 ID 放入網址、瀏覽器儲存空間、公開回應或應用程式日誌。公開端沒有搜尋整表、批次查詢、下載或管理介面。只接受 `active`、`suspended`、`revoked` 狀態；重複、格式錯誤或不完整資料會使名錄 fail closed。ID 欄需在 Sheets 中設為純文字，以免前導零或長 ID 被試算表轉型。

## 正式啟用前必須完成

目前正式網站的查驗功能預設關閉，且 PORTIFY Pages 專案尚無 Google／Turnstile secret。先前工作階段的 Google Workspace 讀取授權回傳 401，無法用目前 connector 直接讀取這份私密試算表；因此不能聲稱已能查真實 ID。

要啟用，需先完成以下最小設定：

1. 在 Google Cloud 建立專用 service account、啟用 Sheets API，並將該帳號以 **Viewer** 身分只分享給官方私密試算表。不要公開 Sheet，也不要授予整個網域或 Editor 權限。提供 service-account JSON key 後，將其只存為 Cloudflare Pages secret `MJVS_GOOGLE_SERVICE_ACCOUNT_JSON`；程式只要求 `https://www.googleapis.com/auth/spreadsheets.readonly` scope。
2. 在 Pages 環境設定 `MJVS_SPREADSHEET_ID`、`TURNSTILE_SITE_KEY`（公開 site key）及 secret `TURNSTILE_SECRET_KEY`。Turnstile widget 需允許正式 Pages 主機名及要使用的 preview 主機名；伺服器會檢查 Siteverify 成功、hostname 及 `mjvs_lookup` action。
3. 部署 `rate-limiter/` 中的 Durable Object Worker，並將它以 `LOOKUP_RATE_LIMITER` 綁定至 Pages Function；另以 Pages secret 設定隨機 `LOOKUP_RATE_LIMIT_PEPPER`。限流器按 HMAC 後的來源 IP hash 限制每分鐘最多 10 次，不保存原始 IP。Cloudflare Pages 文件沒有列出原生 Rate Limiting binding，因此本專案使用獨立 Durable Object；目前既有 PORTIFY token 只有 Pages Write，不能完成 Worker 部署／綁定。
4. 完成正式名錄填寫、逐筆核對、確認 ID 不可預測且不是連號後，才在 Cloudflare Pages 設定 `MJVS_PUBLIC_LOOKUP_ENABLED=true`。名錄為空或不完整時，API 仍會回覆無法確認。不要把任何真實 ID、姓名、護照或名單放入 GitHub、測試 fixture 或公開文件。

所需 Cloudflare 設定值名稱已寫在程式及本文件中，但目前沒有任何真實 Google、Turnstile 或名錄資料存於 repository。服務端 Google key、Turnstile secret、限流 pepper 不可放進 `site/`、`wrangler.jsonc` 或公開原始碼。

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

- [Google Sheets API OAuth scopes](https://developers.google.com/workspace/sheets/api/scopes) — 使用唯讀 `spreadsheets.readonly` scope。
- [Google Cloud credentials](https://developers.google.com/workspace/guides/create-credentials) — service account 憑證管理參考。
- [Cloudflare Turnstile client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/) 與 [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) — 每次 token 都需伺服器端驗證；token 單次使用且 5 分鐘到期。
- [Cloudflare Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/) 與 [Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) — Pages Function 綁定與設定參考。
- [Cloudflare Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — Worker Runtime 的限制說明；Pages Functions bindings 清單未提供原生 Rate Limiting binding，因此需額外的 Durable Object 或自有網域 WAF 規則。
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — 憑證只存 Cloudflare secret，不進公開原始碼。
