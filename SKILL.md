---
name: customer-buyout-delivery
description: 在客戶專用 GitHub 私人儲存庫內快速安裝三平台社群行銷模板，續接失敗的安裝並核對唯讀驗收。
metadata:
  version: "3.0"
---

# AI 安裝 SKILL V3.0

1. 讀取 START-HERE.md、.env.example 和兩個 GitHub Actions workflow。先核對使用者已完成的前置作業。
2. 在客戶自己的私人儲存庫設定 customer-install 環境及受保護的 Secrets。向使用者提供設定名稱及位置，金鑰一律由使用者填入安全介面。
3. 確認目標是客戶新建的 Supabase 專案，或具有同一 project ref 安裝標記的續接專案。取得該客戶的安裝授權後，用 Customer quick install (NO_GO) 一次執行。
4. 失敗時先看 workflow 的失敗步驟。資料庫初始化及安裝標記在同一交易。已初始化且三平台仍關閉發送時，可對相同目標重跑；任何未知的非空資料庫應停止。金鑰、函式及具名預覽工作會重新套用。
5. 回報實際的 workflow 結果、三平台唯讀掃描、權杖健康和 NO_GO 狀態。10 分鐘是前置作業完成後的安裝目標，只有計時驗收後才能宣告達標。
6. 留言回覆範本、基準時間和 Meta 訂閱仍需驗收。保持 SOCIAL_SEND_ENABLED、SOCIAL_TELEGRAM_ENABLED 及三平台 send_enabled 為 false。
