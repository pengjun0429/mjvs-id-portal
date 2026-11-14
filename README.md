# MJVS 免簽 ID 申請與查驗入口

這是 MJVS 的公開網站入口，整理參與方申請、逐一互惠、兩種 ID 建立方式及單筆查驗流程。公開靜態資產只部署 `site/`；Pages Functions 位於專案根層 `functions/`。唯一查驗來源是使用者指定的 Google 試算表，後端透過 Google Visualization CSV query 只請求 A/E 兩欄，不使用 D1，也不把名錄複製進 Git repository。

**資料可見性：**試算表設定為「知道連結的人可以檢視」。原始表格包含 `id`、`country_name`、`registered_name`、`public_name_authorized`、`status` 五欄；任何取得試算表連結的人都能檢視整份表格。網站後端僅請求 A/E 的 `id,status`，API 不回傳姓名、國家或整份名錄；這不會讓來源試算表變成私密。不要把護照號碼、護照影像或其他未授權敏感資料放進表格。

網站流程依工作區提供的《MJVS_規章與流程.md》第 3 版草案整理。加入 MJVS 不會自動與所有參與方互免；至少一份有效互惠協議才可登記為免簽國，協議範圍、目的、停留期限、生效日與例外依個別協議。若已無有效協議，該身分暫停。網站內容不等於規章已正式通過、外交承認或入境保證。

## 查驗結果

`GET /api/config` 會即時讀取 A/E 查詢結果。只有名錄包含至少一筆格式正確的 ID/status 記錄時，查驗輸入才會啟用；空表時網頁顯示「名錄尚未啟用（目前沒有任何 ID 記錄）」。名錄資料已載入時，`POST /api/lookup` 一次只接受一個 ID：`active` 回覆有效；不存在、`suspended` 或 `revoked` 回覆「沒有在免簽名單之內」。名錄為空、格式錯誤或 Google 暫時無法讀取時，API 回覆 503「名錄尚未啟用／無法確認」，不會把空白名錄誤報為查無。

依使用者指示，公開查驗不使用 Turnstile、captcha、rate limiter、pepper 或其他防刷服務，也不需要 Cloudflare secret／人工啟用旗標；當公開名錄出現有效資料後，頁面會依來源狀態自動啟用。這代表公開 API 可以被重複請求；試算表本身也可由知道連結的人檢視完整資料。

目前後端使用的來源查詢為：

`https://docs.google.com/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq?tqx=out:csv&gid=1037470539&tq=select%20A%2CE`

此查詢只選取 A/E 欄，標頭必須為 `id,status`。接受 `active`、`suspended`、`revoked` 狀態；重複 ID、欄位錯誤、不完整資料或超過 5,000 筆會被視為格式異常並停用查驗。ID 欄請設為純文字，避免前導零或長 ID 被試算表轉型。

截至本次更新，來源查詢可讀但目前有 **0 筆名錄記錄**。因此正式網站會顯示「名錄尚未啟用」，查驗按鈕保持停用；直接呼叫 API 也會回覆 503，而不會對任何 ID 判定有效或不在名單內。填入至少一筆核對正確的有效資料後，頁面會自動重新啟用，無需設定 Cloudflare 變數。

## 公開查驗限制

- 只提供單筆 POST 查詢，沒有名錄列表、下載或批次查詢端點。
- 查驗 API 回覆只含有效性與說明，不回傳 ID、姓名、國家或護照資料；ID 不會放入 URL、日誌或瀏覽器儲存空間。
- 來源 Sheet 是公開可檢視，整份名錄可由連結持有人直接查看；不要存放護照或其他不應公開的敏感資料。
- ID 有效不等於自動免簽；目的地仍須依來源方與目的地之有效互惠協議、旅行目的、日期及例外判斷。

## 本機檢查與部署

```sh
node tests/lookup.test.mjs
node --check site/app.js
node --input-type=module --check < functions/api/lookup.js
node --input-type=module --check < functions/api/config.js
node --check functions/lib/registry.mjs

# 靜態預覽
python3 -m http.server 8080 --directory site

# Pages Direct Upload：只部署本專案的 site/，不要部署工作目錄
npx wrangler pages deploy ./site --project-name mjvs-id-portal --branch main
```

Cloudflare Pages 專案採 Direct Upload，沒有連接 GitHub 自動部署。主分支 `main` 是 production branch；`mjvs-preview` 是 preview branch。Functions 由專案根層 `functions/` 自動打包。測試使用的 ID 僅為明確標記的假資料。
