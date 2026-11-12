-- Durable onboarding sessions: a restart or a second app instance cannot
-- replay a code or concurrently bind the same WABA. No tokens/PINs are stored
-- here. All writes are service-role RPCs after the API checks the admin role.
CREATE TABLE IF NOT EXISTS public.whatsapp_signup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  waba_id TEXT,
  phone_number_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS whatsapp_signup_account_created ON public.whatsapp_signup_sessions(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_signup_active_account ON public.whatsapp_signup_sessions(account_id) WHERE status IN ('pending', 'processing');
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_signup_reserved_waba ON public.whatsapp_signup_sessions(waba_id) WHERE status = 'processing';
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_signup_reserved_phone ON public.whatsapp_signup_sessions(phone_number_id) WHERE status = 'processing';
ALTER TABLE public.whatsapp_signup_sessions ENABLE ROW LEVEL SECURITY;
-- No browser read policy: even state hashes and operational sessions stay server-only.
REVOKE ALL ON public.whatsapp_signup_sessions FROM anon, authenticated;
GRANT ALL ON public.whatsapp_signup_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.begin_whatsapp_signup(p_account UUID, p_user UUID, p_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE session_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text, 0));
  IF EXISTS (SELECT 1 FROM whatsapp_config WHERE account_id = p_account) THEN
    RAISE EXCEPTION 'signup_already_connected';
  END IF;
  UPDATE whatsapp_signup_sessions SET status = 'failed'
    WHERE account_id = p_account AND status IN ('pending', 'processing') AND expires_at <= now();
  IF EXISTS (SELECT 1 FROM whatsapp_signup_sessions WHERE account_id = p_account AND
      (status = 'processing' OR created_at > now() - interval '1 minute')) THEN
    RAISE EXCEPTION 'signup_busy';
  END IF;
  UPDATE whatsapp_signup_sessions SET status = 'failed' WHERE account_id = p_account AND status = 'pending';
  INSERT INTO whatsapp_signup_sessions(account_id, user_id, state_hash)
    VALUES(p_account, p_user, p_hash) RETURNING id INTO session_id;
  RETURN session_id;
END $$;

CREATE OR REPLACE FUNCTION public.reserve_whatsapp_signup(p_session UUID, p_account UUID, p_user UUID, p_waba TEXT, p_phone TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Serializes WABA checks across instances, not an in-memory lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_waba, 1));
  UPDATE whatsapp_signup_sessions SET status = 'failed'
    WHERE (waba_id = p_waba OR phone_number_id = p_phone)
      AND status = 'processing' AND expires_at <= now();
  IF EXISTS (SELECT 1 FROM whatsapp_config WHERE account_id = p_account OR waba_id = p_waba OR phone_number_id = p_phone) THEN
    RAISE EXCEPTION 'signup_asset_conflict';
  END IF;
  UPDATE whatsapp_signup_sessions SET waba_id = p_waba, phone_number_id = p_phone
    WHERE id = p_session AND account_id = p_account AND user_id = p_user
      AND status = 'processing' AND expires_at > now() AND waba_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'signup_session_invalid'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.finish_whatsapp_signup(p_session UUID, p_account UUID, p_user UUID, p_token TEXT, p_verify TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s public.whatsapp_signup_sessions;
BEGIN
  SELECT * INTO s FROM whatsapp_signup_sessions WHERE id = p_session AND account_id = p_account
    AND user_id = p_user AND status = 'processing' AND expires_at > now() FOR UPDATE;
  IF NOT FOUND OR s.waba_id IS NULL OR s.phone_number_id IS NULL THEN
    RAISE EXCEPTION 'signup_session_invalid';
  END IF;
  -- INSERT only: never overwrite an existing customer's connection.
  INSERT INTO whatsapp_config(account_id, user_id, phone_number_id, waba_id, access_token, verify_token,
    status, connected_at, registered_at, subscribed_apps_at, last_registration_error)
    VALUES(p_account, p_user, s.phone_number_id, s.waba_id, p_token, p_verify,
      'connected', now(), now(), now(), NULL);
  UPDATE whatsapp_signup_sessions SET status = 'completed' WHERE id = s.id AND account_id = p_account;
END $$;

REVOKE ALL ON FUNCTION public.begin_whatsapp_signup(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_whatsapp_signup(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_whatsapp_signup(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_whatsapp_signup(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_whatsapp_signup(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_signup(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
