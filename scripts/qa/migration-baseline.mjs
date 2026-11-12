import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'

const migrations = new URL('../../supabase/migrations/', import.meta.url)
// PGlite here does not ship pgvector. Exclude the knowledge migrations and
// their direct dependents. The full Supabase replay remains a separate check.
const omitted = new Set(['030', '031', '032', '033'])
const deltas = new Set(['045', '046', '048', '055', '056'])
const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()
const version = (name) => name.split('_', 1)[0]

const db = new PGlite({ extensions: { uuid_ossp } })
try {
  // Minimal platform objects required by CRM SQL. This fixture has no data or
  // connection settings and always starts with a fresh in-memory database.
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (bucket_id text, name text);
    CREATE FUNCTION storage.foldername(name text) RETURNS text[]
      LANGUAGE sql AS $$ SELECT string_to_array(name, chr(47)) $$;
    CREATE PUBLICATION supabase_realtime;
  `)

  const baseline = files.filter((name) => !omitted.has(version(name)) && version(name) <= '044')
  const deltaFiles = files.filter((name) => deltas.has(version(name)))
  assert.deepEqual(deltaFiles.map(version), [...deltas])

  for (const name of [...baseline, ...deltaFiles]) {
    try {
      await db.exec(await readFile(new URL(name, migrations), 'utf8'))
    } catch (error) {
      throw new Error('Migration ' + name + ' failed: ' + error.message, { cause: error })
    }
  }

  const { rows: [catalog] } = await db.query(`
    SELECT
      to_regclass('public.whatsapp_ingress_events') IS NOT NULL AS ingress,
      to_regclass('public.whatsapp_ingress_outbox') IS NOT NULL AS outbox,
      to_regclass('public.ycloud_onboarding_evidence') IS NOT NULL AS evidence,
      to_regclass('public.whatsapp_signup_sessions') IS NOT NULL AS signup,
      to_regprocedure('public.dashboard_metrics(uuid,timestamptz,timestamptz)') IS NOT NULL AS metrics,
      to_regprocedure('public.create_automation_trees(uuid,uuid,jsonb)') IS NOT NULL AS automation
  `)
  assert.ok(Object.values(catalog).every(Boolean), JSON.stringify(catalog))
  const serverOnlyFunctions = [
    'public.enqueue_whatsapp_ingress(jsonb)',
    'public.record_ycloud_onboarding_evidence(text,text,text,text,boolean,text)',
    'public.begin_whatsapp_signup(uuid,uuid,text)',
    'public.reserve_whatsapp_signup(uuid,uuid,uuid,text,text)',
    'public.finish_whatsapp_signup(uuid,uuid,uuid,text,text)',
    'public.create_automation_trees(uuid,uuid,jsonb)',
    'public.update_automation_tree(uuid,uuid,uuid,timestamptz,jsonb,jsonb)',
  ]
  for (const signature of serverOnlyFunctions) {
    const { rows: [grants] } = await db.query(
      "SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, " +
      "has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated, " +
      "has_function_privilege('service_role', $1, 'EXECUTE') AS service_role",
      [signature]
    )
    assert.deepEqual(grants, { anon: false, authenticated: false, service_role: true }, signature)
  }
  console.log('Applied ' + baseline.length + ' baseline files and ' + deltaFiles.length + ' delta files in PGlite.')
} finally {
  await db.close()
}
