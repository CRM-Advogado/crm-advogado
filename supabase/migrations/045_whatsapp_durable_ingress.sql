-- Durable Meta ingress. LOCAL DEVELOPMENT ONLY until environment validation.
-- Additive/idempotent; no deployment, cron registration or feature activation.
-- Payloads are server-only and discarded after transactional materialization.
-- Logical account/connection IDs intentionally have no cascading FK: revocation
-- must not erase accepted work or silently reassign it to another connection.
CREATE TABLE IF NOT EXISTS public.whatsapp_ingress_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id bigint GENERATED ALWAYS AS IDENTITY,
  account_id uuid NOT NULL, connection_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  phone_number_id text NOT NULL, waba_id text,
  event_key text NOT NULL, event_kind text NOT NULL CHECK(event_kind IN
    ('message','reaction','status','template_status','template_quality','template_components')),
  payload jsonb, payload_digest text, state text NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','processing','completed','failed','cancelled')),
  claim_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error_code text,
  received_at timestamptz NOT NULL DEFAULT now(), materialized_at timestamptz,
  UNIQUE(connection_id,event_key)
);
ALTER TABLE public.whatsapp_ingress_events ADD COLUMN IF NOT EXISTS payload_digest text;
ALTER TABLE public.whatsapp_ingress_events ADD COLUMN IF NOT EXISTS sequence_id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.whatsapp_ingress_events ADD COLUMN IF NOT EXISTS cancelled_by uuid;
ALTER TABLE public.whatsapp_ingress_events ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
CREATE INDEX IF NOT EXISTS whatsapp_ingress_pending ON public.whatsapp_ingress_events(next_attempt_at,received_at)
  WHERE state IN ('pending','processing');
CREATE INDEX IF NOT EXISTS whatsapp_ingress_connection_order ON public.whatsapp_ingress_events(connection_id,sequence_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_ingress_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES public.whatsapp_ingress_events(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL, connection_id uuid NOT NULL,
  payload jsonb, state text NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','processing','started','completed','uncertain','cancelled')),
  claim_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), external_started_at timestamptz,
  completed_at timestamptz, last_error_code text
);
ALTER TABLE public.whatsapp_ingress_outbox ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE public.whatsapp_ingress_outbox ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE public.whatsapp_ingress_outbox ADD COLUMN IF NOT EXISTS resolution text;
CREATE INDEX IF NOT EXISTS whatsapp_ingress_outbox_pending ON public.whatsapp_ingress_outbox(created_at)
  WHERE state IN ('pending','processing','started');
ALTER TABLE public.whatsapp_ingress_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_ingress_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_ingress_events,public.whatsapp_ingress_outbox FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.whatsapp_ingress_events,public.whatsapp_ingress_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.whatsapp_ingress_binding_valid(p_event public.whatsapp_ingress_events)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.whatsapp_config c WHERE c.id=p_event.connection_id
    AND c.account_id=p_event.account_id AND c.user_id=p_event.owner_user_id
    AND c.phone_number_id=p_event.phone_number_id AND c.waba_id IS NOT DISTINCT FROM p_event.waba_id
    AND c.status='connected' FOR SHARE;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_whatsapp_ingress(p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; config public.whatsapp_config%ROWTYPE; accepted integer:=0; inserted integer; fingerprint text; previous public.whatsapp_ingress_events%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events)>200 THEN RAISE EXCEPTION 'invalid_ingress_batch'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    SELECT * INTO config FROM public.whatsapp_config c WHERE c.id=(item->>'connection_id')::uuid
      AND c.account_id=(item->>'account_id')::uuid AND c.status='connected' FOR SHARE;
    IF NOT FOUND OR config.phone_number_id IS DISTINCT FROM item->>'phone_number_id'
      OR config.waba_id IS DISTINCT FROM item->>'waba_id' THEN RAISE EXCEPTION 'invalid_ingress_binding'; END IF;
    IF coalesce(length(item->>'event_key'),0) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(item->'payload') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_ingress_event'; END IF;
    fingerprint:=encode(sha256(convert_to(jsonb_build_object('kind',item->>'event_kind','account',config.account_id,'phone',config.phone_number_id,'waba',config.waba_id,'payload',item->'payload')::text,'UTF8')),'hex');
    INSERT INTO public.whatsapp_ingress_events(account_id,connection_id,owner_user_id,phone_number_id,waba_id,event_key,event_kind,payload,payload_digest)
      VALUES(config.account_id,config.id,config.user_id,config.phone_number_id,config.waba_id,item->>'event_key',item->>'event_kind',item->'payload',fingerprint)
      ON CONFLICT(connection_id,event_key) DO NOTHING;
    GET DIAGNOSTICS inserted=ROW_COUNT; accepted:=accepted+inserted;
    IF inserted=0 THEN
      SELECT * INTO previous FROM public.whatsapp_ingress_events WHERE connection_id=config.id AND event_key=item->>'event_key';
      IF previous.payload_digest IS DISTINCT FROM fingerprint OR previous.account_id IS DISTINCT FROM config.account_id THEN RAISE EXCEPTION 'ingress_identity_conflict'; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',accepted,'received',jsonb_array_length(p_events));
END; $$;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_ingress(p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 60)
RETURNS SETOF public.whatsapp_ingress_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; claimed public.whatsapp_ingress_events%ROWTYPE; returned integer:=0;
BEGIN
  IF p_limit IS NULL OR p_lease_seconds IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN RAISE EXCEPTION 'invalid_claim_bounds'; END IF;
  FOR candidate IN SELECT id,connection_id,sequence_id FROM public.whatsapp_ingress_events WHERE
      (state='pending' AND next_attempt_at<=now()) OR (state='processing' AND lease_until<clock_timestamp())
      ORDER BY sequence_id LOOP
    EXIT WHEN returned>=p_limit;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('whatsapp_inbox:'||candidate.connection_id::text,0)) THEN CONTINUE; END IF;
    PERFORM 1 FROM public.whatsapp_ingress_events WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    claimed:=NULL;
    UPDATE public.whatsapp_ingress_events e SET state='processing',claim_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1
      WHERE e.id=candidate.id AND ((e.state='pending' AND e.next_attempt_at<=clock_timestamp())
        OR(e.state='processing' AND e.lease_until<clock_timestamp()))
      AND NOT EXISTS(SELECT 1 FROM public.whatsapp_ingress_events earlier
        WHERE earlier.connection_id=e.connection_id AND earlier.sequence_id<e.sequence_id
          AND earlier.state IN ('pending','processing','failed'))
      RETURNING e.* INTO claimed;
    IF claimed.id IS NOT NULL THEN returned:=returned+1; RETURN NEXT claimed; END IF;
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.materialize_whatsapp_ingress(p_event_id uuid,p_claim_token uuid,p_contact_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
<<materialization>>
DECLARE e public.whatsapp_ingress_events%ROWTYPE; p jsonb; contact_id uuid; conversation_id uuid;
  v_message_id uuid; target_id uuid; created_contact boolean:=false; created_conversation boolean:=false;
  first_inbound boolean:=false; result jsonb:='{}'; out_payload jsonb; t timestamptz; recipient record;
  changed record; changes jsonb:='[]'; allowed text[]; template_state text;
BEGIN
  SELECT * INTO e FROM public.whatsapp_ingress_events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR e.state<>'processing' OR e.claim_token IS DISTINCT FROM p_claim_token OR e.lease_until<clock_timestamp()
    THEN RAISE EXCEPTION 'stale_ingress_claim'; END IF;
  IF NOT public.whatsapp_ingress_binding_valid(e) THEN
    UPDATE public.whatsapp_ingress_events SET state='cancelled',claim_token=NULL,lease_until=NULL,last_error_code='binding_revoked'
      WHERE id=e.id; RETURN jsonb_build_object('cancelled',true);
  END IF;
  p:=e.payload;
  -- Also serialize different events for this account's same phone. No network
  -- I/O is performed while holding this transaction/advisory lock.
  IF e.event_kind IN ('message','reaction') THEN
    IF coalesce(p->>'phone','')!~'^[0-9]{5,15}$' THEN RAISE EXCEPTION 'invalid_sender'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(e.account_id::text||':'||(p->>'phone'),0));
    IF p_contact_id IS NOT NULL THEN
      SELECT id INTO contact_id FROM public.contacts WHERE id=p_contact_id AND account_id=e.account_id AND phone_normalized=p->>'phone' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'invalid_contact_scope'; END IF;
    ELSE
      SELECT id INTO contact_id FROM public.contacts WHERE account_id=e.account_id
        AND phone_normalized=p->>'phone' LIMIT 1 FOR UPDATE;
    END IF;
    IF contact_id IS NULL THEN
      INSERT INTO public.contacts(account_id,user_id,phone,name,first_seen_at)
        VALUES(e.account_id,e.owner_user_id,p->>'phone',coalesce(nullif(p->>'name',''),p->>'phone'),now())
        ON CONFLICT DO NOTHING RETURNING id INTO contact_id;
      created_contact:=contact_id IS NOT NULL;
      IF contact_id IS NULL THEN SELECT id INTO contact_id FROM public.contacts WHERE account_id=e.account_id AND phone_normalized=p->>'phone' FOR UPDATE; END IF;
    END IF;
    IF contact_id IS NULL THEN RAISE EXCEPTION 'contact_not_resolved'; END IF;
    UPDATE public.contacts SET name=coalesce(nullif(p->>'name',''),name),updated_at=now() WHERE id=contact_id AND account_id=e.account_id;
    IF p->'referral' IS NOT NULL AND p->'referral'<>'null'::jsonb THEN
      UPDATE public.contacts SET ad_source_id=p->'referral'->>'source_id',ad_source_type=p->'referral'->>'source_type',
        ad_source_url=p->'referral'->>'source_url',ad_headline=p->'referral'->>'headline',ctwa_clid=p->'referral'->>'ctwa_clid'
        WHERE id=contact_id AND account_id=e.account_id AND ad_source_id IS NULL;
    END IF;
    SELECT id INTO conversation_id FROM public.conversations WHERE account_id=e.account_id AND conversations.contact_id=materialization.contact_id FOR UPDATE;
    IF conversation_id IS NULL THEN
      INSERT INTO public.conversations(account_id,user_id,contact_id,status,unread_count)
        VALUES(e.account_id,e.owner_user_id,contact_id,'open',0) ON CONFLICT DO NOTHING RETURNING id INTO conversation_id;
      created_conversation:=conversation_id IS NOT NULL;
      IF conversation_id IS NULL THEN SELECT id INTO conversation_id FROM public.conversations WHERE account_id=e.account_id AND conversations.contact_id=materialization.contact_id FOR UPDATE; END IF;
    END IF;
    t:=(p->>'occurred_at')::timestamptz;
    IF e.event_kind='reaction' THEN
      SELECT id INTO target_id FROM public.messages WHERE messages.conversation_id=materialization.conversation_id
        AND messages.message_id=p->>'reaction_target_id' ORDER BY created_at LIMIT 1;
      IF target_id IS NULL THEN RAISE EXCEPTION 'reaction_target_missing'; END IF;
      IF coalesce(p->>'emoji','')='' THEN
        DELETE FROM public.message_reactions WHERE message_reactions.message_id=target_id AND actor_type='customer' AND actor_id=contact_id;
      ELSE
        INSERT INTO public.message_reactions(message_id,conversation_id,actor_type,actor_id,emoji)
          VALUES(target_id,conversation_id,'customer',contact_id,p->>'emoji')
          ON CONFLICT(message_id,actor_type,actor_id) DO UPDATE SET emoji=EXCLUDED.emoji;
      END IF;
      IF created_conversation THEN out_payload:=jsonb_build_object('kind','conversation_created','conversation_id',conversation_id,'contact_id',contact_id); END IF;
    ELSE
      SELECT NOT EXISTS(SELECT 1 FROM public.messages m WHERE m.conversation_id=materialization.conversation_id AND m.sender_type='customer') INTO first_inbound;
      SELECT id INTO target_id FROM public.messages m WHERE m.conversation_id=materialization.conversation_id AND m.message_id=p->>'reply_to_provider_id' ORDER BY created_at LIMIT 1;
      INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_url,message_id,status,created_at,reply_to_message_id,interactive_reply_id)
        VALUES(conversation_id,'customer',p->>'content_type',p->>'content_text',p->>'media_url',p->>'message_id','delivered',t,target_id,p->>'interactive_reply_id') RETURNING id INTO v_message_id;
      UPDATE public.conversations c SET unread_count=coalesce(unread_count,0)+1,
        last_message_text=CASE WHEN c.last_message_at IS NULL OR c.last_message_at<=t THEN coalesce(p->>'content_text','['||(p->>'content_type')||']') ELSE c.last_message_text END,
        last_message_at=greatest(c.last_message_at,t),updated_at=now() WHERE c.id=conversation_id;
      UPDATE public.broadcast_recipients SET status='replied',replied_at=now() WHERE id=(
        SELECT br.id FROM public.broadcast_recipients br JOIN public.broadcasts b ON b.id=br.broadcast_id
        WHERE b.account_id=e.account_id AND br.contact_id=materialization.contact_id AND br.status IN ('sent','delivered','read') ORDER BY br.created_at DESC LIMIT 1);
      out_payload:=jsonb_build_object('kind','inbound_dispatch','message_id',v_message_id,'contact_id',contact_id,'conversation_id',conversation_id,
        'owner_user_id',e.owner_user_id,'was_created',created_contact,'conversation_created',created_conversation,'first_inbound',first_inbound);
    END IF;
    result:=jsonb_build_object('contact_id',contact_id,'conversation_id',conversation_id,'message_id',v_message_id);
  ELSIF e.event_kind='status' THEN
    t:=(p->>'occurred_at')::timestamptz;
    allowed:=CASE p->>'status' WHEN 'sent' THEN ARRAY['sending','pending'] WHEN 'delivered' THEN ARRAY['sending','pending','sent']
      WHEN 'read' THEN ARRAY['sending','pending','sent','delivered'] WHEN 'failed' THEN ARRAY['sending','pending','sent'] ELSE ARRAY[]::text[] END;
    FOR changed IN UPDATE public.messages m SET status=p->>'status' FROM public.conversations c
      WHERE m.conversation_id=c.id AND c.account_id=e.account_id AND m.message_id=p->>'message_id' AND m.status=ANY(allowed) RETURNING m.conversation_id LOOP
      changes:=changes||jsonb_build_array(jsonb_build_object('conversation_id',changed.conversation_id,'whatsapp_message_id',p->>'message_id','status',p->>'status'));
    END LOOP;
    UPDATE public.broadcast_recipients br SET status=p->>'status',
      sent_at=CASE WHEN p->>'status'='sent' THEN t ELSE br.sent_at END,
      delivered_at=CASE WHEN p->>'status'='delivered' THEN t ELSE br.delivered_at END,
      read_at=CASE WHEN p->>'status'='read' THEN t ELSE br.read_at END
      FROM public.broadcasts b WHERE br.broadcast_id=b.id AND b.account_id=e.account_id AND br.whatsapp_message_id=p->>'message_id' AND br.status=ANY(allowed);
    IF jsonb_array_length(changes)>0 THEN out_payload:=jsonb_build_object('kind','status_dispatch','updates',changes); END IF;
  ELSIF e.event_kind='template_status' THEN
    UPDATE public.message_templates SET status=p->>'status',rejection_reason=p->>'reason',submission_error=NULL
      WHERE account_id=e.account_id AND meta_template_id=p->>'template_id';
  ELSIF e.event_kind='template_quality' THEN
    UPDATE public.message_templates SET quality_score=p->>'quality' WHERE account_id=e.account_id AND meta_template_id=p->>'template_id';
  -- Components update remains an explicit manual sync diagnostic, not a silent
  -- rewrite of the user's local template content (same semantics as legacy).
  ELSIF e.event_kind='template_components' THEN result:=jsonb_build_object('requires_manual_template_sync',true);
  END IF;
  IF out_payload IS NOT NULL THEN
    INSERT INTO public.whatsapp_ingress_outbox(event_id,account_id,connection_id,payload)
      VALUES(e.id,e.account_id,e.connection_id,out_payload) ON CONFLICT(event_id) DO NOTHING;
  END IF;
  IF e.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'stale_ingress_claim'; END IF;
  UPDATE public.whatsapp_ingress_events SET state='completed',payload=NULL,claim_token=NULL,lease_until=NULL,
    materialized_at=now(),last_error_code=CASE WHEN e.event_kind='template_components' THEN 'manual_template_sync_required' ELSE NULL END WHERE id=e.id;
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.fail_whatsapp_ingress(p_event_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.whatsapp_ingress_events SET state=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,
    next_attempt_at=now()+make_interval(secs=>least(3600,30*attempts)),claim_token=NULL,lease_until=NULL,last_error_code='materialization_failed'
    WHERE id=p_event_id AND state='processing' AND claim_token=p_claim_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_ingress_outbox(p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 60)
RETURNS SETOF public.whatsapp_ingress_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; claimed public.whatsapp_ingress_outbox%ROWTYPE; returned integer:=0;
BEGIN
  IF p_limit IS NULL OR p_lease_seconds IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN RAISE EXCEPTION 'invalid_claim_bounds'; END IF;
  WITH expired AS (SELECT id FROM public.whatsapp_ingress_outbox
    WHERE state='started' AND lease_until<clock_timestamp() FOR UPDATE SKIP LOCKED)
    UPDATE public.whatsapp_ingress_outbox o SET state='uncertain',last_error_code='effect_started_lease_expired',claim_token=NULL,lease_until=NULL
    FROM expired WHERE o.id=expired.id;
  FOR candidate IN SELECT o.id,o.connection_id,e.sequence_id FROM public.whatsapp_ingress_outbox o
    JOIN public.whatsapp_ingress_events e ON e.id=o.event_id
    WHERE o.state='pending' OR (o.state='processing' AND o.lease_until<clock_timestamp())
    ORDER BY e.sequence_id LOOP
    EXIT WHEN returned>=p_limit;
    -- Short DB-only lock, never held across the network effect. A fresh UPDATE
    -- predicate below rechecks state after acquiring this connection fence.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('whatsapp_outbox:'||candidate.connection_id::text,0)) THEN CONTINUE; END IF;
    PERFORM 1 FROM public.whatsapp_ingress_outbox WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    claimed:=NULL;
    UPDATE public.whatsapp_ingress_outbox o SET state='processing',claim_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
      WHERE o.id=candidate.id AND (o.state='pending' OR (o.state='processing' AND o.lease_until<clock_timestamp()))
      AND NOT EXISTS(SELECT 1 FROM public.whatsapp_ingress_events earlier
        WHERE earlier.connection_id=o.connection_id AND earlier.sequence_id<candidate.sequence_id
          AND earlier.state IN ('pending','processing','failed'))
      AND NOT EXISTS(SELECT 1 FROM public.whatsapp_ingress_outbox other
        JOIN public.whatsapp_ingress_events origin ON origin.id=other.event_id
        WHERE other.connection_id=o.connection_id AND other.id<>o.id AND (
          other.state='uncertain' OR (other.state IN ('processing','started') AND other.lease_until>=clock_timestamp())
          OR (origin.sequence_id<candidate.sequence_id AND other.state IN ('pending','processing','started'))))
      RETURNING o.* INTO claimed;
    IF claimed.id IS NOT NULL THEN returned:=returned+1; RETURN NEXT claimed; END IF;
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.start_whatsapp_ingress_outbox(p_outbox_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.whatsapp_ingress_outbox%ROWTYPE; e public.whatsapp_ingress_events%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.whatsapp_ingress_outbox WHERE id=p_outbox_id FOR UPDATE;
  IF NOT FOUND OR o.state<>'processing' OR o.claim_token IS DISTINCT FROM p_claim_token OR o.lease_until<clock_timestamp() THEN RAISE EXCEPTION 'stale_outbox_claim'; END IF;
  SELECT * INTO e FROM public.whatsapp_ingress_events WHERE id=o.event_id;
  IF NOT public.whatsapp_ingress_binding_valid(e) THEN
    UPDATE public.whatsapp_ingress_outbox SET state='cancelled',claim_token=NULL,lease_until=NULL,last_error_code='binding_revoked' WHERE id=o.id;
    RETURN NULL;
  END IF;
  IF o.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'stale_outbox_claim'; END IF;
  UPDATE public.whatsapp_ingress_outbox SET state='started',external_started_at=clock_timestamp() WHERE id=o.id;
  RETURN o.payload;
END; $$;

CREATE OR REPLACE FUNCTION public.finish_whatsapp_ingress_outbox(p_outbox_id uuid,p_claim_token uuid,p_succeeded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.whatsapp_ingress_outbox SET state=CASE WHEN p_succeeded THEN 'completed' ELSE 'uncertain' END,
    completed_at=CASE WHEN p_succeeded THEN now() ELSE NULL END,payload=CASE WHEN p_succeeded THEN NULL ELSE payload END,
    last_error_code=CASE WHEN p_succeeded THEN NULL ELSE 'dispatch_outcome_uncertain' END,claim_token=NULL,lease_until=NULL
    WHERE id=p_outbox_id AND state='started' AND claim_token=p_claim_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.inspect_whatsapp_ingress(p_account_id uuid,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('inbox',coalesce((SELECT jsonb_agg(s) FROM (
    SELECT id,connection_id,event_kind,state,attempts,received_at,materialized_at,last_error_code,cancelled_by,cancelled_at FROM public.whatsapp_ingress_events
      WHERE account_id=p_account_id ORDER BY received_at DESC LIMIT greatest(1,least(p_limit,100))) s),'[]'::jsonb),
    'outbox',coalesce((SELECT jsonb_agg(s) FROM (SELECT id,event_id,connection_id,state,created_at,external_started_at,completed_at,last_error_code,resolved_by,resolved_at,resolution
      FROM public.whatsapp_ingress_outbox WHERE account_id=p_account_id ORDER BY created_at DESC LIMIT greatest(1,least(p_limit,100))) s),'[]'::jsonb));
$$;

-- Operator acknowledgement only. It never returns a job to pending or emits
-- an external action. Exact account scope and durable actor/decision required.
CREATE OR REPLACE FUNCTION public.resolve_whatsapp_ingress_uncertain(
  p_outbox_id uuid,p_account_id uuid,p_operator_id uuid,p_resolution text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_operator_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('confirmed_completed','cancelled_without_retry')
    THEN RAISE EXCEPTION 'invalid_manual_resolution'; END IF;
  UPDATE public.whatsapp_ingress_outbox SET state=CASE WHEN p_resolution='confirmed_completed' THEN 'completed' ELSE 'cancelled' END,
    payload=NULL,resolved_by=p_operator_id,resolved_at=clock_timestamp(),resolution=p_resolution,
    last_error_code='manually_resolved',claim_token=NULL,lease_until=NULL
    WHERE id=p_outbox_id AND account_id=p_account_id AND state='uncertain';
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_whatsapp_ingress(
  p_event_id uuid,p_account_id uuid,p_operator_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_operator_id IS NULL THEN RAISE EXCEPTION 'invalid_manual_cancellation'; END IF;
  -- Payload retained: unresolved/cancelled retention has no approved TTL. This
  -- is explicit operator cancellation, not a silent delete of accepted work.
  UPDATE public.whatsapp_ingress_events SET state='cancelled',cancelled_by=p_operator_id,cancelled_at=clock_timestamp(),
    claim_token=NULL,lease_until=NULL,last_error_code='operator_cancelled'
    WHERE id=p_event_id AND account_id=p_account_id AND state IN ('pending','processing','failed');
  RETURN FOUND;
END; $$;

-- No browser/anonymous execution. Reapplying restores these exact privileges.
DO $$ DECLARE fn regprocedure; BEGIN
  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('whatsapp_ingress_binding_valid','enqueue_whatsapp_ingress','claim_whatsapp_ingress',
      'materialize_whatsapp_ingress','fail_whatsapp_ingress','claim_whatsapp_ingress_outbox','start_whatsapp_ingress_outbox',
      'finish_whatsapp_ingress_outbox','inspect_whatsapp_ingress','resolve_whatsapp_ingress_uncertain','cancel_whatsapp_ingress') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
  END LOOP;
END; $$;
