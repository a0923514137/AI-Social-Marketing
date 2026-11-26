BEGIN;

CREATE TABLE IF NOT EXISTS public.social_token_health (
  platform text PRIMARY KEY
    CHECK (platform IN ('facebook','instagram','threads')),
  expires_at timestamptz,
  data_access_expires_at timestamptz,
  last_checked_at timestamptz,
  last_refreshed_at timestamptz,
  last_alert_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending','healthy','expiring',
      'expired','invalid','error'
    )),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.social_token_health
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.social_token_health
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE
  ON public.social_token_health TO service_role;

INSERT INTO public.social_token_health (platform)
VALUES ('facebook'), ('instagram'), ('threads')
ON CONFLICT (platform) DO NOTHING;

COMMIT;