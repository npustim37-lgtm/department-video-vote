# 系所映像｜特色影片競賽

網站前端部署於 GitHub Pages；Supabase 負責帳號驗證、資料庫及管理員帳號操作。GitHub Pages 本身只能提供靜態檔案，登入與「每人限投一票」由 Supabase 的 Auth、資料庫主鍵與 Row Level Security 執行。

## 功能

- 使用主辦單位建立的姓名、密碼登入；每個帳號只能投給一部作品一次，送出後不能改票。
- 作品卡顯示編號、名稱與影片連結；使用者單選作品後會看到確認訊息，送出成功時顯示完成訊息。
- 管理員可從 `.xlsx` 匯入帳號、手動新增一筆或多筆帳號、修改或刪除帳號，也可一鍵刪除所有投票者帳號。手動新增表單開啟時不顯示輸入列，按「新增一列」後才開始輸入，避免瀏覽器自動填入管理員登入資料。
- 管理員可一次新增多筆作品並自行編輯編號、名稱、影片網址與可投票狀態；已無投票紀錄的作品可刪除。
- 管理員可立即開放或關閉投票，也可設定台灣時間的自動開放及截止時間；可查看即時票數、得票率、投票率及可摺疊的完整投票紀錄。
- 管理員可將投票紀錄與作品統計匯出為一份雙工作表 Excel，或分別匯出 CSV。Excel 投票紀錄不含帳號欄；紀錄 CSV 仍含帳號欄。
- 已登入管理員可在後台直接設定自己的新密碼，下次登入立即生效。
- 刪除使用者時，該使用者的投票紀錄也會刪除，票數會隨之減少。

## 1. 建立 Supabase 專案

1. 在 [Supabase](https://supabase.com/dashboard) 建立專案。
2. 進入 **SQL Editor**，執行 [`supabase/schema.sql`](supabase/schema.sql)。既有專案更新時也須重新執行完整腳本，以加入作品編號、可投票狀態、作品編輯權限與開放時段。原有作品會依資料庫 ID 自動補上編號，原有投票紀錄會保留。執行完成後重新整理網站管理後台；若仍顯示「尚待資料庫更新」，請確認 SQL Editor 執行成功。
3. 進入 **Authentication → Users**，使用 **Add user** 建立一個管理員。使用你自己的 Email 和至少 8 字元的密碼，並確認該帳號已完成 Email 驗證。記下這個 Email。
   建立後，建議在 **Authentication → Settings** 關閉 **Allow new users to sign up**，讓一般帳號只能由管理員建立。
4. 回到 SQL Editor，將下方 `admin@example.com` 換成剛建立的管理員 Email，執行：

   ```sql
   insert into public.profiles (id, name, username, role)
   select id, '管理員', 'admin', 'admin'
   from auth.users
   where email = 'admin@example.com';
   ```

   應顯示新增 1 筆。管理員在網站登入時輸入完整 Email；一般投票者輸入姓名。

5. 部署管理員 Edge Function。在本專案目錄執行：

   ```powershell
   npx supabase login
   npx supabase functions deploy admin-users --project-ref zocsjiwkdobmtwrhjhga --use-api
   ```

   既有專案更新時須重新部署此 Edge Function；「刪除所有投票者帳號」功能需要本版 Function。它使用 Supabase 伺服器內建的 Secret Key，不要把 Secret Key、Service Role Key 或使用者密碼上傳到 GitHub。

   也可不使用 CLI：進入 Supabase Dashboard 的 **Edge Functions → Deploy a new function → Via Editor**，名稱填 `admin-users`，將 [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts) 的完整內容貼入，保持 **Verify JWT** 開啟後按 **Deploy function**。

6. 在 **Project Settings → API Keys** 取得 **Project URL** 與 **Publishable key**。這兩項是前端公開設定；只能使用 `sb_publishable_...` 開頭的金鑰，不能填 Secret Key。

## 2. 設定 GitHub Pages

1. 在 `https://github.com/npust-im/department-video-vote` 的 **Settings → Secrets and variables → Actions → Variables** 建立：

   | 變數 | 值 |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Supabase Project URL，例如 `https://xxxxx.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase Publishable key |

2. 在 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 推送到 `main` 後，[`deploy.yml`](.github/workflows/deploy.yml) 會自動建置並部署。網站預期網址是 `https://npust-im.github.io/department-video-vote/`。
   若尚未填入兩個變數，頁面會顯示「尚未完成連線設定」；填入後重新執行部署工作流程即可啟用。

## 3. 本機啟動

需要 Node.js 20.19+ 或 22.12+。

```powershell
Copy-Item .env.example .env.local
# 在 .env.local 填入 Supabase Project URL 與 Publishable key
npm ci
npm run dev
```

`.env.local`、`node_modules` 與 `dist` 已列入 `.gitignore`。請不要把 Excel 名單或含密碼的檔案提交到倉庫。

## Excel 欄位格式

請將欄名放在第一列，資料從第二列開始；只讀取第一個工作表。欄位順序可調整，也可有其他欄位。

| 姓名 | 密碼 |
| --- | --- |
| 王小明 | example123 |
| 李小華 | example456 |

支援英文欄名 `name`、`password`。舊檔案中的「帳號」欄可保留，但系統會忽略該欄並以姓名作為登入帳號。姓名須為 1–80 字元、不可包含 `@`，且不可重複；密碼不可空白，最多 72 字元，沒有最低字數限制。建議將密碼欄設為「文字」，避免前導零被 Excel 移除。每次最多匯入 2,000 筆；前端分批送出，重複姓名會略過。新設的投票者及管理員密碼會經固定雜湊轉換後交由 Supabase Auth 驗證，原始密碼不寫入本專案資料庫；既有帳號仍可用原密碼登入。

## 既有帳號轉換

部署新版資料庫腳本、Edge Function 與網站後，以管理員登入，按使用者清單上方的「將舊帳號改為姓名」。系統會更新原有投票者的登入帳號；投票紀錄與密碼保持原狀。若有同名使用者或姓名與其他舊帳號衝突，畫面會顯示失敗筆數，請先修改相關姓名，再重新執行。轉換完成後，投票者使用姓名與原密碼登入。

## 計票與匯出

管理後台按得票數由高到低顯示每件作品的票數與得票率，並顯示總投票帳號數、已投票數、尚未投票數和投票率。票數變更透過 Supabase Realtime 更新，頁面也每 10 秒重新讀取一次。完整投票紀錄可摺疊，但三個匯出按鈕始終顯示。Excel 的「投票紀錄」工作表包含作品編號、名稱、投票時間、作品總票數及得票率，不含帳號名稱；紀錄 CSV 仍含帳號名稱。Excel 另有「作品統計」工作表，統計 CSV 可單獨下載。刪除帳號會刪除其投票紀錄；已有票數的作品不能刪除，可在編輯作品時關閉其投票資格，以保留既有紀錄。

按「刪除所有投票者帳號」並確認後，系統會分批刪除目前全部投票者及其投票紀錄，並重新計算票數；管理員帳號不受影響。此操作無法復原，建議先匯出需要保留的資料。若部分刪除失敗，後台會顯示失敗數量，重新整理後可再次執行。

投票時段以台灣時間設定。選「立即開放」可直接投票，截止時間可留空或填未來時間；選「立即關閉」會停止投票；選「依排程」須設定開放與截止時間。資料庫會拒絕時段外投票，並拒絕投給未開放的作品。已登入但未投票的使用者到期後也無法送出。

## 投票限制

`votes.user_id` 是資料庫主鍵，且 Row Level Security 只允許登入的投票者以自己的 ID 新增投票。這能防止重複送出、修改請求或繞過前端按鈕。限制單位是「帳號」；主辦單位應確保名單中每人只有一個帳號。

## 專案結構

- `index.html`、`src/`：GitHub Pages 網站
- `supabase/schema.sql`：資料表與權限規則
- `supabase/functions/admin-users/`：管理員建立、修改、刪除帳號的後端
- `.github/workflows/deploy.yml`：GitHub Pages 自動部署
