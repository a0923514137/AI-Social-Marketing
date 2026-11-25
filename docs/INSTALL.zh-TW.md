# 客戶獨立安裝（候選版）

1. 使用私人 Template 建立客戶獨立儲存庫及全新 Supabase 專案。
2. 驗收後才可在新專案執行 supabase/bootstrap/001_social_schema.sql。禁止在既有系統執行。
3. 依 .env.example 設定 Edge Function Secrets；不得提交真實金鑰。排程金鑰至少 32 字元。
4. 在 SQL Editor 設定客戶關鍵字及文案，例如：

```sql
insert into public.r54_reply_templates(platform,template_key,keyword,reply_text) values ('instagram','price','價格','感謝詢問，歡迎私訊了解。');
```

5. Meta 帳號授權、Webhook HMAC、權杖及 API 權限需各自驗收。IG 海巡僅讀取近期貼文留言，不發送通知。Threads 海巡需 Telegram 設定。
6. 所有發送開關維持 false。正式部署及排程尚未核准，NO_GO。

目前未完成：自動部署工作流程、完整測試、管理後台、跨客戶 OAuth 與商業授權。
