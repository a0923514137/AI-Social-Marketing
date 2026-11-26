BEGIN;

-- 1. Add uncertain delivery status
ALTER TABLE threads_patrol.reply_outbox
DROP CONSTRAINT reply_outbox_status_check;

ALTER TABLE threads_patrol.reply_outbox
ADD CONSTRAINT reply_outbox_status_check
CHECK (
  status IN (
    'pending',
    'leased',
    'sent',
    'dead',
    'uncertain'
  )
);

-- 2. Prevent automatic reclaim of expired leases
CREATE OR REPLACE FUNCTION threads_patrol.claim_replies(
  p_limit integer DEFAULT 10
)
RETURNS TABLE(
  reply_id text,
  post_id text,
  username text,
  body text,
  lease_id uuid,
  attempts integer
)
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid limit';
  END IF;

  UPDATE threads_patrol.reply_outbox o
  SET status = 'uncertain',
      lease_id = NULL,
      lease_until = NULL,
      last_error = 'lease_expired_delivery_unknown',
      updated_at = now()
  WHERE o.status = 'leased'
    AND o.lease_until <= now();

  RETURN QUERY
  WITH candidates AS (
    SELECT o.reply_id
    FROM threads_patrol.reply_outbox o
    WHERE o.status = 'pending'
      AND o.next_attempt_at <= now()
    ORDER BY o.next_attempt_at, o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE threads_patrol.reply_outbox o
  SET status = 'leased',
      lease_id = gen_random_uuid(),
      lease_until = now() + interval '3 minutes',
      attempts = o.attempts + 1,
      updated_at = now()
  FROM candidates c
  WHERE o.reply_id = c.reply_id
  RETURNING o.reply_id, o.post_id, o.username,
            o.body, o.lease_id, o.attempts;
END;
$function$;

-- 3. Record uncertain Telegram delivery
CREATE OR REPLACE FUNCTION public.threads_patrol_uncertain(
  p_reply_id text,
  p_lease_id uuid,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  UPDATE threads_patrol.reply_outbox o
  SET status = 'uncertain',
      lease_id = NULL,
      lease_until = NULL,
      last_error = left(
        coalesce(p_error, 'delivery_unknown'),
        500
      ),
      updated_at = now()
  WHERE o.reply_id = p_reply_id
    AND o.lease_id = p_lease_id
    AND o.status = 'leased';

  RETURN FOUND;
END;
$function$;

REVOKE EXECUTE ON FUNCTION
public.threads_patrol_uncertain(text, uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.threads_patrol_uncertain(text, uuid, text)
TO service_role;

COMMIT;
