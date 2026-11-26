# 快速安裝 V3.0

1. 準備客戶自己的 GitHub 私人儲存庫、全新 Supabase 專案和 Meta 三平台授權。匯入完整 ZIP，包含隱藏的 .github 目錄。
2. 在 GitHub 的 Settings → Environments 建立 customer-install，依 .env.example 和 workflow 集中設定 Secrets。另在儲存庫 Actions Variables 設 CUSTOMER_INSTALL_ENABLED=true。透過 Variables 可選填權杖到期 UNIX 秒數。未提供時，健康檢查能驗證可達性與帳號，期限顯示未知。
3. 在 Actions 觸發 Customer quick install (NO_GO)，兩個輸入填同一個客戶 project ref。workflow 初始化資料庫、部署八支函式、建立四項唯讀排程並驗收。
4. 安裝中斷後先修正失敗原因，再對同一個 project ref 重跑。程式使用資料庫交易及安裝標記辨識續接。舊版若沒有標記且已寫入資料，不會被當成全新專案。
5. 在客戶自己的環境設定固定關鍵字與回覆內容，並核對歷史留言基準、Meta 訂閱和防重複結果。Production 維持 NO_GO，三平台對外發送關閉。

排程在台灣時間每日 09:00–09:03 依序執行 Facebook、Instagram、Threads 預覽及權杖檢查。10 分鐘為前置作業完成後的目標，須以隔離客戶環境計時驗收。
