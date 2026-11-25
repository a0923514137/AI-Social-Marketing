# 快速安裝 V2｜AI 安裝入口
客戶只需上傳完整 ZIP，輸入「請帶領我快速安裝」。AI 先閱讀本文件、AGENTS.md、scripts/ 與 .github/workflows/customer-install.yml。
## 預設快速路徑
1. 一次確認客戶自己的 GitHub 私人儲存庫、全新 Supabase 專案及 Meta 三平台授權是否備妥。匯入完整交付分支，包含隱藏的 .github 目錄。不要逐項重複詢問已完成事項。
2. 引導客戶在 GitHub Settings → Environments 建立 customer-install，於該環境 Secrets 集中設定 SUPABASE_ACCESS_TOKEN、CUSTOMER_DB_URL、FB_PAGE_ID、FB_PAGE_ACCESS_TOKEN、FB_APP_SECRET、FB_WEBHOOK_VERIFY_TOKEN、IG_BUSINESS_ACCOUNT_ID、IG_USERNAME、IG_APP_SECRET、INSTAGRAM_ACCESS_TOKEN、THREADS_ACCESS_TOKEN、SOCIAL_SCHEDULER_KEY（至少32個英數或 _.~- 字元）。真實金鑰不得貼給 AI 或寫入 Git。
3. 確認客戶自己的全新專案 reference；在 Actions 選 Customer quick install (NO_GO)，Run workflow，兩個輸入欄位填相同 reference。必須使用客戶自己的私人儲存庫。取得客戶明確同意後執行一次。
4. 等待 Actions 結果。腳本會初始化 SQL、部署三個 Functions、上傳金鑰、建立預覽排程及執行基本驗收。若失敗，先讀取遮蔽敏感資料的錯誤日誌；不要盲目重跑，部分安裝後新專案檢查會阻擋重跑。
5. 引導 Meta Webhook 訂閱及驗證、設定三平台關鍵字與固定回覆（參考 docs/CUSTOMER-SETUP.zh-TW.md），確認歷史留言截止、受控留言與防重複。未完成不得開啟發送。
## AI 規則
繁體中文；每次提供一個操作階段，可集中同類設定；回覆33或截圖繼續。不得將舊手動流程當預設。只有自動化失敗且確認原因後才採必要人工補救。不得索取真實金鑰或操作原業主專案。
## 限制
10分鐘為帳號及授權備妥後的目標，尚未實測。自動安裝器尚未完成真實客戶驗收；Threads 預覽只檢查設定，IG 海巡唯讀。Meta 訂閱及真實回覆待驗收，NO_GO。
