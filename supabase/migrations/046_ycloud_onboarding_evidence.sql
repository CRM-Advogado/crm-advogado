-- LOCAL CANDIDATE ONLY. Signed onboarding evidence, not tenant authorization.
-- No raw message content, API key, signature or automatic connection is stored.
CREATE TABLE IF NOT EXISTS public.ycloud_onboarding_evidence (
  endpoint_namespace text NOT NULL CHECK(endpoint_namespace ~ '^[a-zA-Z0-9_-]{1,100}$'),
  event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256 AND event_id=btrim(event_id) AND event_id !~ '[[:cntrl:]]'),
  event_type text NOT NULL DEFAULT 'whatsapp.business_account.updated' CHECK(event_type='whatsapp.business_account.updated'),
  update_event text NOT NULL DEFAULT 'PARTNER_ADDED' CHECK(update_event='PARTNER_ADDED'),
  waba_id text NOT NULL CHECK(waba_id ~ '^[0-9]{1,100}$'),
  partner_customer_id text NOT NULL CHECK(length(partner_customer_id) BETWEEN 1 AND 256 AND partner_customer_id=btrim(partner_customer_id) AND partner_customer_id !~ '[[:cntrl:]]'),
  payment_method_attached boolean NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(endpoint_namespace,event_id)
);
ALTER TABLE public.ycloud_onboarding_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ycloud_onboarding_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ycloud_onboarding_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.record_ycloud_onboarding_evidence(
  p_endpoint_namespace text,p_event_id text,p_waba_id text,p_partner_customer_id text,
  p_payment_method_attached boolean,p_payload_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE inserted_count integer; previous public.ycloud_onboarding_evidence%ROWTYPE;
BEGIN
  INSERT INTO public.ycloud_onboarding_evidence(endpoint_namespace,event_id,waba_id,partner_customer_id,payment_method_attached,payload_digest)
    VALUES(p_endpoint_namespace,p_event_id,p_waba_id,p_partner_customer_id,p_payment_method_attached,p_payload_digest)
    ON CONFLICT(endpoint_namespace,event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF inserted_count=0 THEN
    SELECT * INTO previous FROM public.ycloud_onboarding_evidence
      WHERE endpoint_namespace=p_endpoint_namespace AND event_id=p_event_id;
    IF previous.payload_digest IS DISTINCT FROM p_payload_digest OR previous.waba_id IS DISTINCT FROM p_waba_id
      OR previous.partner_customer_id IS DISTINCT FROM p_partner_customer_id
      OR previous.payment_method_attached IS DISTINCT FROM p_payment_method_attached THEN
      RAISE EXCEPTION USING ERRCODE='YC409',MESSAGE='evidence_identity_conflict';
    END IF;
  END IF;
  RETURN jsonb_build_object('inserted',inserted_count=1);
END; $$;
REVOKE ALL ON FUNCTION public.record_ycloud_onboarding_evidence(text,text,text,text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_ycloud_onboarding_evidence(text,text,text,text,boolean,text) TO service_role;
