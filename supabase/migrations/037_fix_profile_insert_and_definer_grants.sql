-- ============================================================
-- 037_fix_profile_insert_and_definer_grants.sql
--
-- Two independent, previously-unpatched authorization gaps found in a
-- security review of the account-sharing model:
--
-- 1) profiles_insert never guarded account_role/account_id
--
--    Migration 034 added a BEFORE UPDATE trigger
--    (enforce_profile_privilege_columns) so the `authenticated` role
--    can't self-promote via UPDATE. But `profiles_insert`
--    (017_account_sharing.sql:617) only checks `auth.uid() = user_id`
--    on INSERT — it never constrains account_role/account_id. Any
--    authenticated user who ends up without a `profiles` row (the
--    signup trigger `handle_new_user` swallows all exceptions and
--    lets signup succeed even if the profile insert fails — see
--    017:679) could INSERT a row naming an arbitrary account_id and
--    account_role='owner', since is_account_member() trusts profiles
--    as ground truth. Fix: widen the 034 trigger to fire on INSERT
--    too, rejecting a self-service insert that sets either column
--    when the caller is the `authenticated` role. handle_new_user and
--    the 018/019 RPCs are unaffected — they run SECURITY DEFINER as
--    `postgres`, not `authenticated`.
--
-- 2) SECURITY DEFINER functions callable by PUBLIC with no ownership
--    check
--
--    recompute_broadcast_counts, _bcast_bump, record_webhook_failure,
--    and claim_ai_reply_slot are all SECURITY DEFINER and take a
--    caller-supplied row id with no auth.uid()/is_account_member()
--    check inside the function body. Every other SECURITY DEFINER
--    function in this schema (007, 012, 018, 019, 022, 025, 030, 036)
--    explicitly revokes the default PUBLIC execute privilege; these
--    four never did (031's own comment documents that a stock/managed
--    Supabase project does not revoke PUBLIC's execute privilege by
--    default). Left as-is, any authenticated — and on some projects,
--    anonymous — caller can invoke them directly via
--    `POST /rest/v1/rpc/<fn>` against another tenant's row id:
--      - recompute_broadcast_counts / _bcast_bump: tamper with another
--        account's broadcast counters.
--      - record_webhook_failure: flip another account's webhook
--        endpoint to is_active=false (targeted DoS).
--      - claim_ai_reply_slot: exhaust another account's AI auto-reply
--        budget for a conversation.
--    All four are called only from internal triggers (PERFORM, which
--    runs as the enclosing DEFINER function's owner, `postgres`) or
--    from the service-role backend client — never from the browser —
--    so revoking PUBLIC and, where relevant, granting only
--    service_role matches actual usage and closes the gap.
-- ============================================================

-- ------------------------------------------------------------
-- 1) profiles: guard INSERT the same way 034 guards UPDATE
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.account_role IS NOT NULL OR NEW.account_id IS NOT NULL)
       AND current_user = 'authenticated'
    THEN
      RAISE EXCEPTION
        'account_role and account_id cannot be set directly; use the account member/invitation RPCs'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- ------------------------------------------------------------
-- 2) Revoke PUBLIC execute on the four unguarded DEFINER functions.
--    Internal callers (triggers owned by postgres; the service-role
--    backend) are unaffected — see rationale above.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, int) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, int) TO service_role;

-- claim_ai_reply_slot already has `GRANT ... TO service_role` from
-- migration 031; only PUBLIC needs revoking here.
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC;

-- ============================================================
-- Manual validation (run against a live instance):
--
--   1. As an authenticated user with no profiles row, both of these
--      must fail with 42501 (insufficient_privilege):
--        POST /rest/v1/profiles
--          { "user_id": "<self>", "account_id": "<other>", "account_role": "owner" }
--        POST /rest/v1/profiles
--          { "user_id": "<self>", "account_role": "owner" }
--   2. A self-service insert that leaves both columns null must still
--      succeed:
--        POST /rest/v1/profiles { "user_id": "<self>", "full_name": "x", "email": "x" }
--   3. As any authenticated user, all of these must now fail with
--      42501 (insufficient_privilege) / permission denied:
--        POST /rest/v1/rpc/recompute_broadcast_counts { "bid": "<any>" }
--        POST /rest/v1/rpc/_bcast_bump { "bid": "<any>", "col": "sent_count", "delta": 1 }
--        POST /rest/v1/rpc/record_webhook_failure { "endpoint_id": "<any>", "max_failures": 1 }
--        POST /rest/v1/rpc/claim_ai_reply_slot { "conversation_id": "<any>", "max_replies": 1 }
--   4. The service-role paths (aggregate trigger on broadcast_recipients,
--      /api/automations webhook delivery, AI auto-reply dispatch) must
--      still work — they call these as service_role or via internal
--      triggers owned by postgres, both unaffected by the PUBLIC revoke.
-- ============================================================
