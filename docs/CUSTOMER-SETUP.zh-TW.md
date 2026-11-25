# 客戶自行申請與串接指南（候選版）

本產品採客戶獨立帳號、獨立資料庫架構。供應商不代管客戶權杖。

## 1. GitHub
前往 https://github.com/signup 註冊，取得供應商交付的程式碼後匯入自己的私人 repository。若使用私人 Template，需先取得存取權限。啟用 Actions，確認預設分支包含驗收 workflow。

## 2. Supabase
前往 https://supabase.com/dashboard/new 建立全新專案。記錄 Project Reference ID、Project URL。資料庫密碼、service role key、access token 僅由客戶保存，不可提交 GitHub 原始碼或傳給供應商。
在 SQL Editor 執行 supabase/bootstrap/001_social_schema.sql（須先完成候選版驗收，僅限全新專案）。此腳本不是重複執行型 migration。

## 3. Meta
前往 https://developers.facebook.com/ 建立自己的 App，依 Meta 實際提供的產品及權限流程連接自己管理的 Facebook 粉專、Instagram 專業帳號及 Threads 帳號。實際權限、App Review 與商業驗證依帳號使用情境決定。
依 .env.example 在 Supabase Edge Function Secrets 設定 FB_PAGE_ID、FB_PAGE_ACCESS_TOKEN、FB_APP_SECRET、FB_WEBHOOK_VERIFY_TOKEN、IG_BUSINESS_ACCOUNT_ID、IG_USERNAME、IG_APP_SECRET、INSTAGRAM_ACCESS_TOKEN、THREADS_ACCESS_TOKEN。SOCIAL_SCHEDULER_KEY 使用至少 32 字元的隨機密鑰。兩個發送開關維持 false。
部署後才能將 meta-webhook 的實際 URL 設為 Meta callback；Webhook 驗證與簽章檢查必須通過。不得使用供應商既有專案 URL。

## 4. 三平台相同回覆
在客戶 SQL Editor 設定（以下為範例）：
```sql
insert into public.r54_reply_templates(platform,template_key,keyword,reply_text)
select p,'price','價格','感謝詢問，歡迎私訊了解。'
from unnest(array['facebook','instagram','threads']) as t(p)
on conflict(platform,template_key) do update
set keyword=excluded.keyword,reply_text=excluded.reply_text;
```

## 5. Telegram（選用）
客戶自行透過 BotFather 建立 Bot，設定 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID。未驗收前保持 SOCIAL_TELEGRAM_ENABLED=false。

## 6. 驗收與啟用
執行 Customer template validation。確認資料庫、權限、Webhook、三平台測試留言、防重複、歷史留言截止及發送失敗處理後，才可核准開啟發送。IG 海巡目前為唯讀預覽。
目前尚無完整一鍵部署、排程安裝及新客戶端到端驗收；本文件為候選版，不代表可正式上線。NO_GO。
