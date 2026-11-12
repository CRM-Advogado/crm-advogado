-- PERF-01: load the four dashboard cards in one authenticated round trip.
-- The browser supplies the local day boundaries; existing read RLS still applies.
CREATE OR REPLACE FUNCTION public.dashboard_metrics(
  p_account_id uuid,
  p_today_start timestamptz,
  p_yesterday_start timestamptz
)
RETURNS TABLE (
  open_conversations bigint,
  new_open_conversations_today bigint,
  new_open_conversations_yesterday bigint,
  new_contacts_today bigint,
  new_contacts_yesterday bigint,
  won_deals_count bigint,
  won_deals_value numeric,
  sent_messages_today bigint,
  sent_messages_yesterday bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT conv.total, conv.today, conv.yesterday, contacts.today, contacts.yesterday,
         deals.total, deals.total_value, messages.today, messages.yesterday
  FROM (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE created_at >= p_today_start) AS today,
           count(*) FILTER (WHERE created_at >= p_yesterday_start
                            AND created_at < p_today_start) AS yesterday
    FROM public.conversations
    WHERE account_id = p_account_id AND status = 'open'
  ) conv
  CROSS JOIN (
    SELECT count(*) FILTER (WHERE created_at >= p_today_start) AS today,
           count(*) FILTER (WHERE created_at < p_today_start) AS yesterday
    FROM public.contacts
    WHERE account_id = p_account_id AND created_at >= p_yesterday_start
  ) contacts
  CROSS JOIN (
    SELECT count(*) AS total, coalesce(sum(value), 0) AS total_value
    FROM public.deals
    WHERE account_id = p_account_id AND status = 'won'
  ) deals
  CROSS JOIN (
    SELECT count(*) FILTER (WHERE m.created_at >= p_today_start) AS today,
           count(*) FILTER (WHERE m.created_at < p_today_start) AS yesterday
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.account_id = p_account_id
      AND m.sender_type = 'agent'
      AND m.created_at >= p_yesterday_start
  ) messages
  WHERE public.is_account_member(p_account_id);
$$;

REVOKE ALL ON FUNCTION public.dashboard_metrics(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_metrics(uuid, timestamptz, timestamptz)
  TO authenticated;
