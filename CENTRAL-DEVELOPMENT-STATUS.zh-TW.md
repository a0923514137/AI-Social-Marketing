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
