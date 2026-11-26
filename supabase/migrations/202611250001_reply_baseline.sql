BEGIN;

ALTER TABLE public.r54_reply_controls
ADD COLUMN IF NOT EXISTS reply_baseline_at timestamptz;

COMMIT;
