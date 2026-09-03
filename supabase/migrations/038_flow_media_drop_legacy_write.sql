-- ============================================================
-- 038_flow_media_drop_legacy_write.sql
--
-- Closes a stale-authorization gap in the flow-media write policies
-- introduced as an intentional bridge by migration 020.
--
-- 020 added an account-scoped write check for flow-media but kept a
-- `OR auth.uid()::text = (storage.foldername(name))[1]` fallback so
-- the original uploader of a pre-020 (user-scoped path) object didn't
-- lose write access to their own files. That fallback checks literal
-- `auth.uid()` against the path, never current account membership.
-- `remove_account_member` (018_account_member_rpcs.sql) reassigns a
-- removed member to a brand-new personal account rather than deleting
-- their auth user, so a former member's `auth.uid()` never changes —
-- meaning they permanently retain UPDATE/DELETE on any legacy-path
-- object they originally uploaded, even after losing all read access
-- to the account's flows that may still reference it.
--
-- Five migrations (and, in production, a lot of real time) have
-- passed since 020 introduced the account-scoped path convention, so
-- the backward-compat bridge has long outlived its purpose. Dropping
-- it closes the gap; the account-scoped branch (added in 020) is the
-- only write path going forward. This is a narrowing change: any
-- object still sitting under the old `<uid>/...` path becomes
-- effectively read-only (the bucket's SELECT policy is unconditionally
-- public, so it stays readable — including by flow nodes that
-- reference its URL) until re-uploaded under the current
-- `account-<uuid>/...` convention.
-- ============================================================

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- Public read policy from 016 is untouched — reads stay public so
-- Meta can fetch media URLs without credentials.
