# V38 中央開發狀態

更新日期 2026-11-28（台灣時間）。Production **NO_GO**。

## 基線與驗收範圍

- 基線為 GitHub `agent00/coordination-v38` 的 `6af831b`。原始目錄是 R132 安裝候選版，開發及整合在獨立的 V38 worktree 進行。
- `6af831b` 相對於 `cf1cd83` 只更新 `AGENTS.md`。後者的 A01 候選版 CI 已通過，沿用這份證據。[GitHub Actions 執行紀錄](https://github.com/a0923514137/AI-Social-Marketing/actions/runs/46060592448)
- 驗收範圍為本機靜態檢查及隔離模擬。雲端安裝、部署、資料庫變更、Webhook 與排程設定、真實發送均未授權。
- 整合分支 CI、實際平台和 Staging 驗收均為 **PENDING**。

## 子代理交付

| Agent | 本機分支 | 交付與驗證 |
| --- | --- | --- |
| 01 | `codex/v38-agent01` | `7d051e8`。FB／IG 在解析事件前驗證原始內容的 HMAC，2 項離線路由測試通過。部署環境的 JWT 設定與實際事件仍待驗收。 |
| 02 | `codex/v38-agent02` | `c979d8d`、退回修正 `eaf2764`。掃描標示部分覆蓋與可回覆的命中，海巡確認帳號身分，並在 Telegram 入列、認領及發送前重查閘門。5 項離線測試通過。 |
| 03 | `codex/v38-agent03` | `7991a5a`、退回修正 `650b007`、`1af47d1`。TikTok 沿用 social-worker 提供指定自有影片的唯讀留言統計，4 項離線測試通過。YouTube 預覽讀取既有頻道設定，單次發送前重查全域、頻道、環境及指定留言條件和認領有效期限，22 項離線測試通過。 |
| 04 | `codex/v38-agent04` | `ffc50da`、退回修正 `6c8fc07`。Telegram 管理回覆及舊草稿通知受發送開關控制，既有授權關鍵字操作保留。舊通知拒絕重新導向，須收到 Telegram 成功回應才回報送達。1 組離線測試的 5 個步驟通過。 |
| 05 | `codex/v38-agent05` | `18cba01`。嚴格驗證全域啟用狀態，發送前再查環境開關。2 項離線測試通過，涵蓋併發去重及關閉閘門時的零發送。 |
| 06 | `codex/v38-agent06` | `568fcec`。獨立驗收與整合程式提交 `e0c8346` 內容相符。36 項測試及另計的 5 個測試步驟通過，0 項失敗。 |

## 本機驗收命令

```powershell
deno test --cached-only --deny-net --allow-env=FB_APP_SECRET,FB_PAGE_ID,FB_PAGE_ACCESS_TOKEN,IG_BUSINESS_ACCOUNT_ID,IG_USERNAME,INSTAGRAM_ACCESS_TOKEN,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SOCIAL_SEND_ENABLED,SOCIAL_FB_SEND_ENABLED,R53_TELEGRAM_WEBHOOK_SECRET,R53_TELEGRAM_ADMIN_ID,R53_TELEGRAM_CHAT_ID,TELEGRAM_BOT_TOKEN,SOCIAL_TELEGRAM_ENABLED,THREADS_PATROL_ADMIN_KEY,SOCIAL_SCHEDULER_KEY,YOUTUBE_SCHEDULER_KEY,YOUTUBE_SINGLE_TEST_ENABLED,YOUTUBE_SINGLE_TEST_COMMENT_ID,THREADS_ACCESS_TOKEN,TELEGRAM_CHAT_ID supabase/functions/social-webhook/routing_test.ts supabase/functions/social-admin/index_test.ts supabase/functions/shared/social_test.ts supabase/functions/social-worker/threads_safety_test.ts supabase/functions/social-worker/tiktok_test.ts supabase/functions/social-worker/youtube_test.ts supabase/functions/social-worker/youtube_gate_test.ts
deno check --cached-only supabase/functions/social-webhook/index.ts supabase/functions/social-admin/index.ts supabase/functions/social-worker/index.ts
git diff --check codex/v38-baseline HEAD
```

Agent 00 在整合提交 `e0c8346` 上完成三個入口的型別檢查及 Git 差異檢查，結果通過。

## 發行待驗收

- TikTok 目前提供預覽統計。真實帳號授權、留言讀取及回覆整合待驗收。
- YouTube 預覽保留既有資料庫配額記帳。全新頻道未提供基準且沒有設定列時，以該次請求時間為基準。真實單次發送及 Staging 排程待驗收。
- FB／IG 的真實 Webhook 收件及部署環境 JWT 設定、Threads 平台讀取與回覆、Telegram 真實通知與既有候選資料庫結構相容性待驗收。
- 併發認領與不確定送達已用模擬驗證。實際資料庫併發待驗收。平台 HTTP 呼叫一旦開始，資料庫開關無法撤回該請求。
- 本機整合工作使用 `codex/v38-agent00`。本輪無新 Edge Function、SQL 或 Supabase 設定差異，無推送、部署、資料庫變更或真實發送。

## 第二輪整合

基線 `66404e2`。整合分支 `codex/v38-agent00`。Production **NO_GO**。

- 既有候選 workflow 在整合分支 push 時執行四平台回覆與 Telegram 驗證。TikTok 唯讀預覽另有獨立工作，無安裝或部署步驟。
- 第一次雲端驗證中，TikTok 預覽通過。四平台工作發現 YouTube 的等長關鍵字排序依執行環境而異，已退修。[首次 CI 紀錄](https://github.com/a0923514137/AI-Social-Marketing/actions/runs/46091529557)
- 受控回覆依平台設定單一留言 ID。FB 與 IG 的簽章 Webhook 從已驗證事件取留言 ID。IG worker 的 `run` 另要求請求提供同一 `comment_id`。Threads `scan` 使用本次執行開始時設定的目標。YouTube `run` 保留專屬目標與頻道限制。
- 候選共用 schema 仍在 `integration-candidate/migrations`，須經授權後於隔離 Staging 核對匯入與部署版本。全新安裝流程尚未納入該候選 SQL。真實資料庫併發、Webhook、平台權限和發送均待驗收。
- 第二次雲端驗證確認修正後的四平台工作與獨立 TikTok 工作均通過。共用候選規則保留指定貼文優先，其次最長關鍵字，等長時優先採留言裡最早出現的關鍵字。[排序修正後的 CI 紀錄](https://github.com/a0923514137/AI-Social-Marketing/actions/runs/46091781275)

| Agent | 本機分支與提交 | 第二輪交付 |
| --- | --- | --- |
| 01 | `codex/v38-r2-agent01`，`3addb2c`、退修 `b67ad1a` | 新舊 Meta Webhook 每批固定同一測試留言。舊版 FB 發送前重查專屬控制與 Telegram 共用開關。IG worker 檢查請求目標，Webhook 與 worker 共用永久防重。 |
| 02 | `codex/v38-r2-agent02`，`b459e79` | Threads 掃描只認領該次指定留言，預覽與原排程介面保留。 |
| 03 | `codex/v38-r2-agent03`，`1dda553`、退修 `274cb38` | YouTube 只為指定留言評估與防重查詢，並與其餘三平台共用固定的關鍵字排序。 |
| 03（TikTok） | `codex/v38-r2-tiktok`，`d01ff33` | 修正唯讀留言 API 分頁參數為 `max_count`。實際帳號授權、回應驗證及回覆整合獨立待辦。[官方留言 API](https://business-api.tiktok.com/portal/docs/get-comments-on-an-owned-video/v1.3) |
| 04 | `codex/v38-r2-agent04`，`172246b` | Telegram `/off` 在通知前關閉共用開關，Bot Token 缺失或通知錯誤仍可暫停。關鍵字管理區分全域與指定貼文。 |
| 05 | `codex/v38-r2-agent05`，`cdb5c95` | FB、IG、Threads 共用閘門在認領與發送前核對精確留言 ID。既有永久唯一鍵保留。 |
| 06 | `codex/v38-r2-agent06-final`，驗收內容對齊 `a85da18` | 四平台與 Telegram 44 項離線測試及另計 7 步驟通過。TikTok 獨立 4 項通過。四個入口的型別檢查通過。 |

雲端驗證僅執行型別檢查及禁止網路的模擬測試。沒有新增 Edge Function、套用 SQL、執行部署或發送。

整合程式提交 `a85da18` 的 GitHub CI 已完成，`v38-integration` 與 `v38-tiktok-preview` 均通過。驗收沿用該提交的 workflow 測試清單及環境變數允許清單，本機另加 `--cached-only`。[第二輪最終 CI](https://github.com/a0923514137/AI-Social-Marketing/actions/runs/46091960909)

Staging 須驗證平台 Webhook、排程及實際資料庫契約。舊版 Meta Webhook 仍讀取舊版模板，共用關鍵字驗收應由統一 Webhook 入口處理。兩個入口若同時接收同一 Facebook 留言，永久認領可防重複發送，但先取得認領的入口會決定所用模板。客戶安裝流程與實際路由仍為 **PENDING**。
