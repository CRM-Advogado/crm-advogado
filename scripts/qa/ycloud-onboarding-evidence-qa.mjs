import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const settings = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55484),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
};
assert.ok(['localhost', '127.0.0.1', '::1'].includes(settings.host), 'QA requires local disposable PostgreSQL');
const database = `ycloud_evidence_qa_${Date.now()}`;
assert.match(database, /^ycloud_evidence_qa_[0-9]+$/);
const admin = new pg.Client({ ...settings, database: process.env.PGDATABASE || 'postgres' });
const connect = () => new pg.Client({ ...settings, database });
let db;
let created = false;
const results = [];
const table = 'public.ycloud_onboarding_evidence';
const args = () => ['endpoint-a', 'event-a', '123456', 'opaque-customer-a', true, 'a'.repeat(64)];
const signature = 'public.record_ycloud_onboarding_evidence(text,text,text,text,boolean,text)';
async function record(values = args(), client = db) {
  return (await client.query('SELECT public.record_ycloud_onboarding_evidence($1,$2,$3,$4,$5,$6) AS result', values)).rows[0].result;
}
async function test(name, run) {
  await db.query(`TRUNCATE ${table}`);
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { await db.query('ROLLBACK'); results.push({ name, passed: false }); console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  await admin.connect();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $$`);
  await admin.query(`CREATE DATABASE ${database}`); created = true;
  db = connect(); await db.connect();
  const migration = await readFile(new URL('../../supabase/migrations/046_ycloud_onboarding_evidence.sql', import.meta.url), 'utf8');
  await db.query(migration);
  await test('migration is reentrant and preserves evidence', async () => {
    await record(); await db.query(migration);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
  });
  await test('identical replay returns inserted false', async () => {
    assert.deepEqual(await record(), { inserted: true });
    assert.deepEqual(await record(), { inserted: false });
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
  });
  await test('same event in separate endpoint namespaces stays separate', async () => {
    await record(); const b = args(); b[0] = 'endpoint-b'; await record(b);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 2);
  });
  for (const [index, value] of [[2, '999999'], [3, 'opaque-customer-b'], [4, false], [5, 'b'.repeat(64)]]) {
    await test(`immutable identity rejects conflicting field ${index}`, async () => {
      await record(); const changed = args(); changed[index] = value;
      await assert.rejects(record(changed), (error) => error.code === 'YC409');
      const row = (await db.query(`SELECT waba_id,partner_customer_id,payment_method_attached,payload_digest FROM ${table}`)).rows[0];
      assert.deepEqual(row, { waba_id: '123456', partner_customer_id: 'opaque-customer-a', payment_method_attached: true, payload_digest: 'a'.repeat(64) });
    });
  }
  await test('concurrent identical calls persist exactly one row', async () => {
    const other = connect(); await other.connect();
    try { const values = await Promise.all([record(), record(args(), other)]); assert.equal(values.filter((r) => r.inserted).length, 1); }
    finally { await other.end(); }
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
  });
  await test('concurrent conflicting calls preserve one immutable winner', async () => {
    const other = connect(); await other.connect();
    const changed = args(); changed[5] = 'b'.repeat(64);
    try { const values = await Promise.allSettled([record(), record(changed, other)]); assert.equal(values.filter((r) => r.status === 'fulfilled').length, 1); const rejected = values.find((r) => r.status === 'rejected'); assert.equal(rejected.reason.code, 'YC409'); }
    finally { await other.end(); }
  });
  await test('caller transaction rollback leaves no acceptance', async () => {
    await db.query('BEGIN'); await record(); await db.query('ROLLBACK');
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  });
  for (const role of ['anon', 'authenticated']) {
    await test(`${role} cannot execute evidence RPC or read table`, async () => {
      await record(); await db.query(`SET ROLE ${role}`);
      try {
        await assert.rejects(record(), (error) => error.code === '42501');
        await assert.rejects(db.query(`SELECT * FROM ${table}`), (error) => error.code === '42501');
      } finally { await db.query('RESET ROLE'); }
    });
    await test(`RLS denies ${role} even if accidental SELECT grant exists`, async () => {
      await record(); await db.query(`GRANT SELECT ON ${table} TO ${role}`); await db.query(`SET ROLE ${role}`);
      try { assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0); }
      finally { await db.query('RESET ROLE'); await db.query(`REVOKE SELECT ON ${table} FROM ${role}`); }
    });
  }
  await test('service role can record and inspect but cannot mutate evidence directly', async () => {
    await db.query('SET ROLE service_role');
    try {
      assert.deepEqual(await record(), { inserted: true });
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
      await assert.rejects(db.query(`UPDATE ${table} SET partner_customer_id='changed'`), (error) => error.code === '42501');
      await assert.rejects(db.query(`DELETE FROM ${table}`), (error) => error.code === '42501');
    } finally { await db.query('RESET ROLE'); }
  });
  await test('function is security definer with fixed search path and no public execute', async () => {
    const row = (await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
    assert.equal(row.prosecdef, true); assert.ok(row.proconfig.includes('search_path=public, pg_temp'));
    assert.equal((await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') ok`, [signature])).rows[0].ok, false);
  });
  await test('schema contains no raw payload, signature, key, account or activation column', async () => {
    const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ycloud_onboarding_evidence'")).rows.map((r) => r.column_name);
    for (const forbidden of ['payload', 'raw_body', 'signature', 'api_key', 'account_id', 'connection_id', 'operational', 'status']) assert.ok(!cols.includes(forbidden));
  });
  const invalid = [[0, 'endpoint/evil'], [1, ''], [1, ' event'], [1, 'event\n'], [1, 'x'.repeat(257)], [2, 'waba-not-digits'], [3, ''], [3, 'customer\n'], [3, 'x'.repeat(257)], [4, null], [5, 'not-a-digest']];
  for (const [index, value] of invalid) {
    await test(`invalid field ${index} ${JSON.stringify(value).slice(0, 25)} is rejected`, async () => {
      const values = args(); values[index] = value;
      await assert.rejects(record(values), (error) => ['23514', '23502'].includes(error.code));
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    });
  }
  await test('false payment attachment remains valid evidence only', async () => {
    const values = args(); values[4] = false; await record(values);
    assert.equal((await db.query(`SELECT payment_method_attached FROM ${table}`)).rows[0].payment_method_attached, false);
  });
  console.log(JSON.stringify({ passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results }, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  if (db) await db.end();
  if (created) await admin.query(`DROP DATABASE ${database} WITH(FORCE)`);
  await admin.end();
}
