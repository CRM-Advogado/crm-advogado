-- Local candidate: first-cycle identity reservation and evidence correlation only.
-- No link issuance, phone activation, provider authorization or message sending.
CREATE INDEX IF NOT EXISTS ycloud_evidence_customer_arrival ON public.ycloud_onboarding_evidence(endpoint_namespace,partner_customer_id,received_at);
CREATE TABLE IF NOT EXISTS public.ycloud_customer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_namespace text NOT NULL CHECK(endpoint_namespace ~ '^[a-zA-Z0-9_-]{1,100}$'),
  account_id uuid NOT NULL,
  partner_customer_id text NOT NULL DEFAULT gen_random_uuid()::text,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','evidence_matched','manual_review')),
  waba_id text,
  evidence_event_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(endpoint_namespace,account_id),
  UNIQUE(endpoint_namespace,partner_customer_id),
  UNIQUE(endpoint_namespace,waba_id),
  UNIQUE(endpoint_namespace,evidence_event_id),
  FOREIGN KEY(endpoint_namespace,evidence_event_id)
    REFERENCES public.ycloud_onboarding_evidence(endpoint_namespace,event_id) ON DELETE RESTRICT,
  CHECK((waba_id IS NULL)=(evidence_event_id IS NULL)),
  CHECK(state<>'evidence_matched' OR evidence_event_id IS NOT NULL)
);
-- Logical account/actor IDs intentionally do not cascade: accepted evidence and
-- WABA claims must not be released or silently reassigned on tenant deletion.
CREATE TABLE IF NOT EXISTS public.ycloud_onboarding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL UNIQUE REFERENCES public.ycloud_customer_links(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK(expires_at=created_at+interval '2 hours')
);
ALTER TABLE public.ycloud_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ycloud_onboarding_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ycloud_customer_links,public.ycloud_onboarding_sessions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ycloud_customer_links,public.ycloud_onboarding_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.assert_ycloud_onboarding_actor(p_account_id uuid,p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.profiles p WHERE p.user_id=p_actor_id AND p.account_id=p_account_id
    AND p.account_role::text IN ('admin','owner') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='YC403',MESSAGE='onboarding_forbidden'; END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.get_ycloud_onboarding_status(p_account_id uuid,p_actor_id uuid,p_endpoint_namespace text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.ycloud_customer_links%ROWTYPE; session public.ycloud_onboarding_sessions%ROWTYPE; status text; evidence_count integer;
BEGIN
  PERFORM public.assert_ycloud_onboarding_actor(p_account_id,p_actor_id);
  IF p_endpoint_namespace IS NULL OR p_endpoint_namespace !~ '^[a-zA-Z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION USING ERRCODE='YC400',MESSAGE='invalid_endpoint_namespace'; END IF;
  SELECT * INTO link FROM public.ycloud_customer_links l WHERE l.account_id=p_account_id AND l.endpoint_namespace=p_endpoint_namespace;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_started','operational',false,'coexistenceVerified',false); END IF;
  SELECT * INTO STRICT session FROM public.ycloud_onboarding_sessions s WHERE s.link_id=link.id;
  status:=CASE WHEN link.state='reserved' AND clock_timestamp()>=session.expires_at THEN 'expired' ELSE link.state END;
  IF link.state='evidence_matched' THEN
    SELECT count(*) INTO evidence_count FROM public.ycloud_onboarding_evidence e
      WHERE e.endpoint_namespace=p_endpoint_namespace AND e.partner_customer_id=link.partner_customer_id;
    IF evidence_count<>1 OR NOT EXISTS(SELECT 1 FROM public.ycloud_onboarding_evidence e
      WHERE e.endpoint_namespace=p_endpoint_namespace AND e.partner_customer_id=link.partner_customer_id
        AND e.event_id=link.evidence_event_id AND e.waba_id=link.waba_id
        AND e.received_at>=session.created_at AND e.received_at<=session.expires_at) THEN
      -- New contradictory evidence invalidates a candidate immediately on read;
      -- keep the original WABA claim and leave persistent review to reconciliation.
      status:='manual_review';
    END IF;
  END IF;
  RETURN jsonb_build_object('status',status,'sessionId',session.id,'expiresAt',session.expires_at,'operational',false,'coexistenceVerified',false);
END; $$;

CREATE OR REPLACE FUNCTION public.reserve_ycloud_onboarding(p_account_id uuid,p_actor_id uuid,p_endpoint_namespace text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.ycloud_customer_links%ROWTYPE; session public.ycloud_onboarding_sessions%ROWTYPE; reserved_at timestamptz;
BEGIN
  PERFORM public.assert_ycloud_onboarding_actor(p_account_id,p_actor_id);
  IF p_endpoint_namespace IS NULL OR p_endpoint_namespace !~ '^[a-zA-Z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION USING ERRCODE='YC400',MESSAGE='invalid_endpoint_namespace'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ycloud-reserve:'||p_endpoint_namespace||':'||p_account_id::text,0));
  SELECT * INTO link FROM public.ycloud_customer_links l WHERE l.account_id=p_account_id AND l.endpoint_namespace=p_endpoint_namespace FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO STRICT session FROM public.ycloud_onboarding_sessions s WHERE s.link_id=link.id;
    IF link.state='manual_review' OR clock_timestamp()>=session.expires_at THEN
      RAISE EXCEPTION USING ERRCODE='YC409',MESSAGE='onboarding_manual_review_required'; END IF;
    RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace);
  END IF;
  reserved_at:=clock_timestamp();
  INSERT INTO public.ycloud_customer_links(endpoint_namespace,account_id,created_at)
    VALUES(p_endpoint_namespace,p_account_id,reserved_at) RETURNING * INTO link;
  -- A restored/corrupt identity that already has evidence must never start a
  -- fresh local cycle. Normal UUIDs are generated only in this transaction.
  IF EXISTS(SELECT 1 FROM public.ycloud_onboarding_evidence e WHERE e.endpoint_namespace=p_endpoint_namespace AND e.partner_customer_id=link.partner_customer_id) THEN
    RAISE EXCEPTION USING ERRCODE='YC409',MESSAGE='preexisting_onboarding_evidence'; END IF;
  INSERT INTO public.ycloud_onboarding_sessions(link_id,requested_by,created_at,expires_at)
    VALUES(link.id,p_actor_id,reserved_at,reserved_at+interval '2 hours');
  RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace);
END; $$;

CREATE OR REPLACE FUNCTION public.reconcile_ycloud_onboarding(p_account_id uuid,p_actor_id uuid,p_endpoint_namespace text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.ycloud_customer_links%ROWTYPE; session public.ycloud_onboarding_sessions%ROWTYPE;
  evidence public.ycloud_onboarding_evidence%ROWTYPE; evidence_count integer;
BEGIN
  PERFORM public.assert_ycloud_onboarding_actor(p_account_id,p_actor_id);
  IF p_endpoint_namespace IS NULL OR p_endpoint_namespace !~ '^[a-zA-Z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION USING ERRCODE='YC400',MESSAGE='invalid_endpoint_namespace'; END IF;
  SELECT * INTO link FROM public.ycloud_customer_links l WHERE l.account_id=p_account_id AND l.endpoint_namespace=p_endpoint_namespace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='YC409',MESSAGE='onboarding_not_reserved'; END IF;
  SELECT * INTO STRICT session FROM public.ycloud_onboarding_sessions s WHERE s.link_id=link.id;
  IF link.state='manual_review' THEN RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace); END IF;
  -- Count ALL evidence, not just the time window: never hide contradictory WABAs.
  SELECT count(*) INTO evidence_count FROM public.ycloud_onboarding_evidence e
    WHERE e.endpoint_namespace=p_endpoint_namespace AND e.partner_customer_id=link.partner_customer_id;
  IF evidence_count=0 AND clock_timestamp()<session.expires_at THEN
    RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace); END IF;
  IF evidence_count<>1 THEN
    UPDATE public.ycloud_customer_links SET state='manual_review' WHERE id=link.id;
    RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace);
  END IF;
  SELECT * INTO STRICT evidence FROM public.ycloud_onboarding_evidence e
    WHERE e.endpoint_namespace=p_endpoint_namespace AND e.partner_customer_id=link.partner_customer_id;
  -- received_at is arrival time, never proof of provider creation/attempt time.
  IF evidence.received_at<session.created_at OR evidence.received_at>session.expires_at
    OR (link.state<>'evidence_matched' AND clock_timestamp()>=session.expires_at)
    OR (link.evidence_event_id IS NOT NULL AND (link.evidence_event_id<>evidence.event_id OR link.waba_id<>evidence.waba_id)) THEN
    UPDATE public.ycloud_customer_links SET state='manual_review' WHERE id=link.id;
    RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace);
  END IF;
  -- Namespace+WABA uniqueness serializes competing customer claims. Keep the
  -- previous claim on conflicts, including terminal/manual-review identities.
  BEGIN
    UPDATE public.ycloud_customer_links SET state='evidence_matched',waba_id=evidence.waba_id,evidence_event_id=evidence.event_id
      WHERE id=link.id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.ycloud_customer_links SET state='manual_review' WHERE id=link.id;
  END;
  RETURN public.get_ycloud_onboarding_status(p_account_id,p_actor_id,p_endpoint_namespace);
END; $$;

REVOKE ALL ON FUNCTION public.assert_ycloud_onboarding_actor(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_ycloud_onboarding_status(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_ycloud_onboarding(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reconcile_ycloud_onboarding(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_ycloud_onboarding_actor(uuid,uuid),public.get_ycloud_onboarding_status(uuid,uuid,text),public.reserve_ycloud_onboarding(uuid,uuid,text),public.reconcile_ycloud_onboarding(uuid,uuid,text) TO service_role;
