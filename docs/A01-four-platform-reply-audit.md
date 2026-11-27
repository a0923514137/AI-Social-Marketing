# A01 four-platform reply audit

Status: IN_PROGRESS; production NO_GO.
Base: ad179a2bc7302fca9f14afadb02131c311eba4ff.
Runtime baseline: social-worker v28, social-admin v28, social-webhook v25.
Runtime differs from repository; do not deploy this branch as-is.

## Verified read-only findings
- FB/IG/Threads use social_rules and social_reply_switch; environment send gates also apply. Legacy platform controls are not consulted by the shared delivery helper.
- IG cron preview; Threads cron scan_preview; YouTube cron preview.
- YouTube worker rejects all non-preview requests; uses legacy templates; no YouTube-specific template rows observed.
- Reply claim tables empty at audit time. Webhook edge logs: 2 GET, 1 POST; no social_webhook processing event in sampled function logs.
- Preserve deduplication, activation baseline, account checks, signature checks and uncertain delivery handling.

## Acceptance
Reconcile runtime source with repository privately before changing runtime code. Verify API access, webhook delivery, keyword routing and controlled real reply per platform. No deployment, schedule changes, secret changes or external sends authorized by this audit.
