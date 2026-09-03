-- ============================================================
-- 039_practice_area.sql — Practice area segmentation (level 1)
--
-- Adds practice area ("category") to contacts and deals.
-- Does NOT alter any RLS policies: visibility remains
-- per-account, exactly as before. This column is for
-- filtering, reporting, and routing.
--
-- Conversations do not receive this column by design: they
-- inherit the practice area from contacts via join. A column
-- nobody fills creates divergence between two places that
-- should agree.
--
-- Idempotent — safe to run multiple times.
-- ============================================================


-- ############################################################
-- #  HERE: your list of practice areas.
-- #
-- #  Edit ONLY the two lists marked below (they must be
-- #  identical to each other). Each value is a KEY, not a
-- #  UI label:
-- #    - lowercase, no accents, no spaces (use hyphens)
-- #    - chosen never to change
-- #
-- #  The pretty name that appears in the UI lives in the app
-- #  and can be changed anytime, without touching the database.
-- #  E.g. key 'corporate' -> label "Corporate Law"
-- ############################################################

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS practice_area TEXT;
ALTER TABLE deals    ADD COLUMN IF NOT EXISTS practice_area TEXT;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_practice_area_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_practice_area_check
  CHECK (practice_area IS NULL OR practice_area IN (
    -- >>> LIST 1 — edit here <<<
    'corporate',
    'litigation',
    'family-law',
    'ip-law',
    'real-estate',
    'other'
  ));

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_practice_area_check;
ALTER TABLE deals ADD CONSTRAINT deals_practice_area_check
  CHECK (practice_area IS NULL OR practice_area IN (
    -- >>> LIST 2 — repeat exactly the list above <<<
    'corporate',
    'litigation',
    'family-law',
    'ip-law',
    'real-estate',
    'other'
  ));


-- NULL is always accepted: legacy contacts, imports, or
-- unclassified contacts have no practice area until a flow
-- assigns one. Only an invalid value is rejected — and that's
-- the point, because the value is set by hand in the
-- `update_contact_field` automation. A typo ("corporat" instead
-- of "corporate") would silently split your reports; with the
-- constraint, the automation fails and appears in the log.

COMMENT ON COLUMN contacts.practice_area IS
  'Lead practice area. Populated by triage flow via update_contact_field automation.';
COMMENT ON COLUMN deals.practice_area IS
  'Deal practice area. Normally copied from contact at deal creation.';

-- Índices parciais: indexam só as linhas já classificadas.
CREATE INDEX IF NOT EXISTS idx_contacts_practice_area
  ON contacts(account_id, practice_area)
  WHERE practice_area IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_practice_area
  ON deals(account_id, practice_area)
  WHERE practice_area IS NOT NULL;
