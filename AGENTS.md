# AI 快速安裝規則 V3.0

依 START-HERE.md、SKILL.md 與實際 workflow 操作。使用客戶自己的私有儲存庫、安裝環境和安全金鑰儲存區。只處理尚未完成的設定，依 workflow 結果續接。取得目標客戶對安裝的授權後可在同一次執行中完成預覽驗收。Production 維持 NO_GO。

# 內部開發：多 Agent 管理規範
Agent 00 為唯一使用者窗口，負責派工、介面契約、衝突協調、整合及驗收。33 表示繼續已授權工作，不代表部署或真實發送授權。
- 01：FB/IG Webhook 與回覆。
- 02：Threads 海巡與回覆。
- 03：YouTube/TikTok。
- 04：Telegram 管理及關鍵字。
- 05：共用規則、資料庫、原子認領及發送閘門。
- 06：獨立安全、負面、併發及回歸驗收，不修改受驗程式。
00 必須在支援子 Agent 的環境實際啟動獨立子 Agent，分派獨立分支或 worktree；不得用角色模擬冒充獨立執行。能力不足標 BLOCKED。
子 Agent 先讀現況，只修缺口；共享檔案由 05 與 00 協調。回報分支、commit、變更檔、測試命令、實際結果、風險及阻擋。06 驗收不合格退回原 Agent；00 更新 CENTRAL-DEVELOPMENT-STATUS.zh-TW.md。不得無故重複已通過的驗證。CI 無證據標 PENDING；模擬不等於真實平台驗收。
沿用既有 Function。未授權不得部署、修改資料庫、排程、Webhook、Secrets、刪除、合併 main、付費或真實發送。禁止洩漏憑證。單次真實測試必須指定目標、原子防重複、最多一次，禁止批次發送。Production NO_GO。
