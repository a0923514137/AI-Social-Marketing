# 三明治爸爸社群整合候選版

**狀態：候選版，Production NO_GO。** 此分支的自動化只檢查程式與本機 PostgreSQL。三支部署入口位於 `integration-candidate/social-worker`、`social-webhook` 與 `social-admin`。

## 規則與送出控制

- Migration 將三平台 `r54_reply_templates` 匯入共用回覆，將啟用中的 `r53_keyword_rules` 匯入指定貼文適用範圍。保留原表供舊版及回滾使用。全域與指定貼文共用同一文字。若原資料同一正規化關鍵字有不同回覆，Migration 會整筆回滾，需先確認採用哪一份。
- 比對採 Unicode NFKC、忽略大小寫、子字串。指定貼文優先，同範圍內較長關鍵字優先。Telegram 新增的規則預設全域，回覆限 500 字。既有指定貼文關鍵字可在 Telegram 修改或刪除。刪除也會移除指定貼文關聯。
- Telegram「選單」提供六個按鈕。按鈕新增、修改和刪除均需確認。亦可直接使用 `/add 關鍵字 | 回覆`、`/edit 關鍵字 | 回覆`、`/delete 關鍵字`、`/list`、`/on`、`/off`。驗證管理者 ID、聊天室 ID 和 Webhook Secret，資料庫對 Telegram update 去重。重送可能重複顯示通知，資料庫操作只執行一次。
- `/on`、`/off` 控制三平台候選版共用開關。預設關閉。從關閉轉為開啟會建立新時間基準，避免回覆停用期間或更早的留言。實際回覆需同時通過 `SOCIAL_SEND_ENABLED`，FB 及 IG 各加用自己的 `SOCIAL_FB_SEND_ENABLED`、`SOCIAL_IG_SEND_ENABLED`。Threads 海巡 Telegram 通知仍由原本環境開關管理，YouTube 使用原限制。
- 同一平台、同一留言用原有 `r54_reply_claims` 唯一鍵。送出前再確認開關與啟用時間，已有認領的留言不自動重送。外部服務已接收的請求無法由 `/off` 撤回。

## 切換順序

1. 在已授權的隔離 Staging，以同等資料表、版本與最小範圍測試帳戶驗證。確認備份、四項排程定義、Meta 與 Telegram 目前的 Webhook URL、舊資料來源寫入者及可回滾版本。全程保持候選版發送開關關閉。
2. 告知管理者暫停編輯舊規則後，套用 `integration-candidate/migrations/` 的 Migration。比對匯入筆數與指定貼文範圍。部署時將 `social-worker`、`social-webhook`、`social-admin` 及 `shared` 一起納入 bundle，保留相對匯入。驗證部署設定允許平台 Webhook 與排程進入各自的應用層驗證。
3. 無發送驗收涵蓋三平台讀取、指定貼文及全域規則、同則留言重送、Telegram 管理者與聊天室驗證。Meta 使用測試 App／測試帳戶驗證 `/functions/v1/social-webhook` 的 challenge、簽章與事件。Telegram 使用測試 Bot 將 URL 指向 `/functions/v1/social-admin`，設定 secret token 並只訂閱需要的 message、callback_query。正式切換前保留既有 URL。
4. 獲授權後逐一移轉排程，保持原有頻率及認證從 Vault 讀取。同一功能一次只留一個生效排程。首個週期核對實際 HTTP 結果及零發送，再逐步切換 Webhook 到候選入口。
5. 真實回覆須另行獲授權。每平台先用一則受控新留言測試，核對只出現一筆認領、一則實際回覆，再重送事件驗證去重。切換失敗時先暫停候選版發送，恢復原 Webhook 與排程。已發生的認領保留。若 Telegram 已修改候選版規則，先讓管理者核對後再回填舊版所需的差異。

| 現有每五分鐘排程 | 候選 Worker 預覽 payload | 受控驗收後的模式 |
| --- | --- | --- |
| `r54_threads_auto_reply_staging_5min` | `threads_scan / scan_preview` | `threads_scan / scan` |
| `r55_instagram_patrol_staging_5min` | `instagram_patrol / preview` | 維持預覽，避免與 IG 發送掃描重複 |
| `r55_instagram_auto_reply_staging_5min` | `instagram_reply / preview` | `instagram_reply / run` |
| `threads_patrol_staging_5min` | `threads_patrol / run_preview` | 如需原 Telegram 通知，單獨核准 `run` |
| `threads_r52_daily_draft_0900_taipei` | 維持停用 | 維持停用 |

Worker 接收 JSON `{"task":"…","mode":"…"}`。以上對應以交接資料為基礎，切換前需核對每個舊排程 payload 與實際行為。

## 本次補齊的舊入口對應

| 舊入口 | 候選 URL 後綴與行為 |
| --- | --- |
| `r54-06-resolve-post-staging` | `GET /functions/v1/social-worker?task=threads_resolve_post&url=<URL-encoded permalink>`。只查登入帳號的 Threads 貼文，逐頁比對帳號與 shortcode，保留 `post_id`、`pages_scanned`。未傳 URL 時用 `THREADS_RESOLVE_DEFAULT_URL`，未設定才用舊預設網址。新入口需 Service Role、Threads 管理金鑰或排程金鑰。 |
| `threads-keyword-search-v2-staging` | `POST /functions/v1/social-worker?task=threads_keyword_search`。Service Role 或 V2 管理金鑰驗證，沿用 V2 搜尋 Token。支援唯讀 `preview`／`search_only`、`diagnostic`，以及 `collect`／舊版 `run_preview` 候選入庫。兩個入庫模式保留 20 分鐘視窗與貼文 ID 去重，無 AI 呼叫或發送。可傳最多 12 個 `keywords`，未傳時使用共用全域規則。全域規則超出上限時請明確傳入一組關鍵字。 |
| `threads-r53-review-staging` | `POST /functions/v1/social-admin?task=threads_review`。沿用 Service Role 或 Threads 管理金鑰，保留臺北日期、版本歷史、建立、重新產生時提交文案、修改、核准、取消。核准後禁止重新產生，`bind_post` 仍要求獨立啟用。Telegram 草稿流程仍走原有回呼入口。 |
| `r69-facebook-admin-review-staging` | `POST /functions/v1/social-admin?task=facebook_review`。以原 Supabase 使用者 Bearer Token 呼叫，伺服器驗證 `app_metadata.facebook_review_admin`。支援 `OPTIONS`、`list`、`edit`、`approve`、`cancel`，沿用既有審核 RPC 與稽核，核准不觸發發送。 |

切換時保留原 HTTP 方法與請求內容，依上述表更換 URL，並確認原本無鑑權的貼文解析呼叫者已能安全提供憑證。驗收先用唯讀搜尋與草稿列表。候選入庫、審核寫入與真實回覆按授權範圍在 Staging 分開測試。

## 舊入口淘汰清單

以下只作為依賴交叉核對清單。需查 Cron、Vault 引用、Meta／Telegram 回呼、內部呼叫與實際流量。完成替代功能與觀察後才可申請淘汰。

| 原入口 | 候選對應及尚待項目 |
| --- | --- |
| `social-worker` | 相同對外名稱，保留版本供回滾 |
| `r56-social-integration-candidate-staging` | Worker，逐一核對既有 task |
| `r56-social-content-staging` | Worker，四個現有排程待遷移 |
| `r57-facebook-webhook-staging` | Webhook，待切換及實際收到事件 |
| `r54-02-threads-auto-reply-staging` | Worker Threads scan，待比對回覆行為 |
| `r54-03-threads-reply-guard-staging` | Worker 與資料庫去重，待核對原呼叫者 |
| `r54-06-resolve-post-staging` | Worker 獨立解析入口，待切換呼叫者 |
| `threads-r53-telegram-webhook-staging` | Admin，待切換 Telegram Webhook |
| `threads-r53-telegram-staging` | Admin，待比對管理入口 |
| `threads-r53-review-staging` | Admin 日期式草稿審核及既有 Telegram 草稿回呼，待切換呼叫者 |
| `threads-ai-reply-r53-staging` | Worker 固定回覆，獨立 AI 產生回覆能力待確認 |
| `threads-keyword-search-v2-staging` | Worker 獨立關鍵字搜尋與候選入庫，待用 Meta 測試授權驗證 |
| `r69-facebook-admin-review-staging` | Admin 獨立 FB 候選審核，待以 Supabase 測試管理者驗證 |
| `r64-facebook-reply-candidate-staging` | Webhook 回覆、Worker 模擬，待比對審核／呼叫入口 |
| `r60-facebook-bridge-test-staging` | Webhook，待核對 bridge 和測試呼叫者 |

所有既有 Function 保留。IG／FB 實際 API 權限與回覆驗收、所有舊入口等效性、排程及 Webhook 轉移仍待授權後驗證。
