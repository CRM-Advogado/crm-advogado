import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const settings = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 55484), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD };
assert.ok(['localhost', '127.0.0.1', '::1'].includes(settings.host), 'QA requires local disposable PostgreSQL');
const name = `ycloud_customer_link_qa_${Date.now()}`;
assert.match(name, /^ycloud_customer_link_qa_[0-9]+$/);
const admin = new pg.Client({ ...settings, database: process.env.PGDATABASE || 'postgres' });
const connect = () => new pg.Client({ ...settings, database: name });
const A = '10000000-0000-0000-0000-000000000001', B = '10000000-0000-0000-0000-000000000002';
const UA = '20000000-0000-0000-0000-000000000001', UB = '20000000-0000-0000-0000-000000000002';
let db; let created = false; const results = [];
const tables = ['ycloud_onboarding_sessions', 'ycloud_customer_links', 'ycloud_onboarding_evidence'];
async function call(operation, account = A, actor = UA, namespace = 'endpoint-a', client = db) {
  assert.ok(['reserve', 'reconcile', 'get'].includes(operation));
  const fn = operation === 'get' ? 'get_ycloud_onboarding_status' : `${operation}_ycloud_onboarding`;
  return (await client.query(`SELECT public.${fn}($1,$2,$3) result`, [account, actor, namespace])).rows[0].result;
}
async function link(account = A, namespace = 'endpoint-a') {
  return (await db.query('SELECT * FROM ycloud_customer_links WHERE account_id=$1 AND endpoint_namespace=$2', [account, namespace])).rows[0];
}
async function evidence(account = A, { id = 'event-a', namespace = 'endpoint-a', waba = '123456', payment = true } = {}) {
  const identity = await link(account, namespace);
  await db.query('SELECT record_ycloud_onboarding_evidence($1,$2,$3,$4,$5,$6)', [namespace, id, waba, identity.partner_customer_id, payment, 'a'.repeat(64)]);
}
async function expire(account = A) {
  await db.query("UPDATE ycloud_onboarding_sessions s SET created_at=now()-interval '3 hours', expires_at=now()-interval '1 hour' FROM ycloud_customer_links l WHERE s.link_id=l.id AND l.account_id=$1", [account]);
}
async function test(title, run) {
  await db.query('TRUNCATE ycloud_onboarding_sessions,ycloud_customer_links,ycloud_onboarding_evidence,profiles');
  await db.query("INSERT INTO profiles VALUES($1,$2,'owner'),($3,$4,'admin')", [UA, A, UB, B]);
  try { await run(); results.push({ title, passed: true }); console.log(`PASS ${title}`); }
  catch (error) { await db.query('ROLLBACK'); await db.query('RESET ROLE'); results.push({ title, passed: false }); console.log(`FAIL ${title}: ${error.message}`); }
}
try {
  await admin.connect();
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$");
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  db = connect(); await db.connect();
  await db.query('CREATE TABLE profiles(user_id uuid PRIMARY KEY,account_id uuid NOT NULL,account_role text NOT NULL)');
  const migration046 = await readFile(new URL('../../supabase/migrations/046_ycloud_onboarding_evidence.sql', import.meta.url), 'utf8');
  const migration047 = await readFile(new URL('../../supabase/migrations/047_ycloud_customer_links.sql', import.meta.url), 'utf8');
  await db.query(migration046); await db.query(migration047);
  await test('migration reapplies without changing identity or TTL', async () => {
    const first = await call('reserve'); const identity = await link(); await db.query(migration047);
    assert.deepEqual(await call('get'), first); assert.equal((await link()).partner_customer_id, identity.partner_customer_id);
  });
  await test('initial status has no session and creates nothing', async () => {
    assert.deepEqual(await call('get'), { status: 'not_started', operational: false, coexistenceVerified: false });
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_customer_links')).rows[0].n, 0);
  });
  await test('server creates opaque identity and one exact two-hour session', async () => {
    const result = await call('reserve'); const identity = await link();
    assert.equal(result.status, 'reserved'); assert.match(identity.partner_customer_id, /^[a-f0-9-]{36}$/);
    assert.notEqual(identity.partner_customer_id, A); assert.equal(identity.state, 'reserved');
    const session = (await db.query("SELECT *,extract(epoch FROM expires_at-created_at)::int AS seconds FROM ycloud_onboarding_sessions WHERE link_id=$1", [identity.id])).rows[0];
    assert.equal(session.seconds, 7200); assert.equal(session.requested_by, UA);
    assert.equal(result.operational, false); assert.equal(result.coexistenceVerified, false);
    for (const forbidden of ['partnerCustomerId', 'wabaId', 'accountId', 'namespace', 'eventId']) assert.ok(!Object.hasOwn(result, forbidden));
  });
  await test('repeated reserve returns the original session and expiry', async () => {
    const first = await call('reserve'); assert.deepEqual(await call('reserve'), first);
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_onboarding_sessions')).rows[0].n, 1);
  });
  await test('concurrent reserves do not rotate identity or create multiple sessions', async () => {
    const other = connect(); await other.connect();
    try { const [one, two] = await Promise.all([call('reserve'), call('reserve', A, UA, 'endpoint-a', other)]); assert.deepEqual(one, two); }
    finally { await other.end(); }
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_customer_links')).rows[0].n, 1);
  });
  await test('restored identity with preexisting evidence cannot start a fresh cycle', async () => {
    const restored = '30000000-0000-0000-0000-000000000001';
    await db.query('BEGIN');
    try {
      await db.query(`ALTER TABLE ycloud_customer_links ALTER COLUMN partner_customer_id SET DEFAULT '${restored}'`);
      await db.query('SELECT record_ycloud_onboarding_evidence($1,$2,$3,$4,$5,$6)', ['endpoint-a', 'old-event', '123456', restored, true, 'a'.repeat(64)]);
      await db.query('SAVEPOINT before_reserve');
      await assert.rejects(call('reserve'), (error) => error.code === 'YC409');
      await db.query('ROLLBACK TO SAVEPOINT before_reserve');
      assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_customer_links')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_onboarding_sessions')).rows[0].n, 0);
    } finally { await db.query('ROLLBACK'); }
  });
  await test('membership row is fenced against concurrent revocation until transaction completes', async () => {
    const other = connect(); await other.connect();
    await db.query('BEGIN');
    try {
      await call('reserve');
      await other.query("SET lock_timeout='100ms'");
      await assert.rejects(other.query('DELETE FROM profiles WHERE user_id=$1', [UA]), (error) => error.code === '55P03');
      await db.query('COMMIT');
      await other.query('DELETE FROM profiles WHERE user_id=$1', [UA]);
      await assert.rejects(call('get'), (error) => error.code === 'YC403');
    } finally { await db.query('ROLLBACK'); await other.end(); }
  });
  for (const operation of ['reserve', 'reconcile', 'get']) {
    await test(`${operation} refuses actor from another account`, async () => {
      await assert.rejects(call(operation, A, UB), (error) => error.code === 'YC403');
    });
    await test(`${operation} refuses an actor removed after HTTP authentication`, async () => {
      await call('reserve'); await db.query('DELETE FROM profiles WHERE user_id=$1', [UA]);
      await assert.rejects(call(operation), (error) => error.code === 'YC403');
    });
  }
  for (const role of ['agent', 'viewer']) {
    await test(`database rejects ${role} actor`, async () => {
      await db.query('UPDATE profiles SET account_role=$1 WHERE user_id=$2', [role, UA]);
      await assert.rejects(call('reserve'), (error) => error.code === 'YC403');
    });
  }
  await test('different accounts receive different opaque identities and isolated status', async () => {
    const a = await call('reserve'); const b = await call('reserve', B, UB);
    assert.notEqual(a.sessionId, b.sessionId); assert.notEqual((await link()).partner_customer_id, (await link(B)).partner_customer_id);
    await evidence(A); await call('reconcile'); assert.equal((await call('get', B, UB)).status, 'reserved');
  });
  await test('namespace mismatch cannot reconcile evidence', async () => {
    await call('reserve'); await evidence(A);
    await assert.rejects(call('reconcile', A, UA, 'endpoint-b'), (error) => error.code === 'YC409');
    assert.equal((await call('get')).status, 'reserved');
  });
  await test('reconcile without reservation is refused', async () => {
    await assert.rejects(call('reconcile'), (error) => error.code === 'YC409');
  });
  await test('no evidence leaves a current reservation pending', async () => {
    const first = await call('reserve'); assert.deepEqual(await call('reconcile'), first);
  });
  await test('a matching signed-ledger row creates candidate evidence only', async () => {
    await call('reserve'); await evidence(A);
    const result = await call('reconcile');
    assert.equal(result.status, 'evidence_matched'); assert.equal(result.operational, false); assert.equal(result.coexistenceVerified, false);
    assert.equal((await link()).waba_id, '123456'); assert.equal((await link()).evidence_event_id, 'event-a');
  });
  await test('reconciliation replay is stable and never creates a second session', async () => {
    await call('reserve'); await evidence(A); const first = await call('reconcile'); assert.deepEqual(await call('reconcile'), first);
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_onboarding_sessions')).rows[0].n, 1);
  });
  await test('payment false remains only candidate evidence without activation', async () => {
    await call('reserve'); await evidence(A, { payment: false });
    const result = await call('reconcile'); assert.equal(result.operational, false); assert.equal(result.coexistenceVerified, false);
  });
  await test('expiry cannot renew the stable identity or session', async () => {
    await call('reserve'); const identity = await link(); await expire();
    assert.equal((await call('get')).status, 'expired');
    await assert.rejects(call('reserve'), (error) => error.code === 'YC409');
    assert.equal((await link()).partner_customer_id, identity.partner_customer_id);
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_onboarding_sessions')).rows[0].n, 1);
  });
  await test('expired reconcile is terminal manual review even with no evidence', async () => {
    await call('reserve'); await expire(); assert.equal((await call('reconcile')).status, 'manual_review');
    await assert.rejects(call('reserve'), (error) => error.code === 'YC409');
  });
  await test('evidence received before the reservation cannot create a candidate', async () => {
    await call('reserve'); await evidence(A);
    await db.query("UPDATE ycloud_onboarding_evidence SET received_at=clock_timestamp()-interval '1 day'");
    assert.equal((await call('reconcile')).status, 'manual_review'); assert.equal((await link()).waba_id, null);
  });
  await test('late first evidence cannot authorize a new local cycle', async () => {
    await call('reserve'); await expire(); await evidence(A);
    assert.equal((await call('reconcile')).status, 'manual_review'); assert.equal((await link()).evidence_event_id, null);
  });
  await test('multiple events for the same stable identity require review', async () => {
    await call('reserve'); await evidence(A); await evidence(A, { id: 'event-b' });
    assert.equal((await call('reconcile')).status, 'manual_review'); assert.equal((await link()).waba_id, null);
  });
  await test('a contradictory WABA outside the time window is not hidden', async () => {
    await call('reserve'); await evidence(A); await evidence(A, { id: 'event-b', waba: '999999' });
    await db.query("UPDATE ycloud_onboarding_evidence SET received_at=clock_timestamp()-interval '1 day' WHERE event_id='event-b'");
    assert.equal((await call('reconcile')).status, 'manual_review');
  });
  await test('later contradiction preserves the old WABA claim while requiring review', async () => {
    await call('reserve'); await evidence(A); await call('reconcile'); await evidence(A, { id: 'event-b', waba: '999999' });
    assert.equal((await call('reconcile')).status, 'manual_review'); assert.equal((await link()).waba_id, '123456');
  });
  await test('status detects later contradictory evidence without an explicit reconcile', async () => {
    await call('reserve'); await evidence(A); await call('reconcile');
    await evidence(A, { id: 'event-b', waba: '999999' });
    assert.equal((await call('get')).status, 'manual_review');
    assert.equal((await link()).waba_id, '123456');
    assert.equal((await link()).evidence_event_id, 'event-a');
  });
  await test('one WABA cannot be claimed by two accounts in a namespace', async () => {
    await call('reserve'); await call('reserve', B, UB); await evidence(A); await evidence(B, { id: 'event-b' });
    await call('reconcile'); assert.equal((await call('reconcile', B, UB)).status, 'manual_review');
    assert.equal((await link()).waba_id, '123456'); assert.equal((await link(B)).waba_id, null);
  });
  await test('concurrent WABA claims have only one candidate winner', async () => {
    await call('reserve'); await call('reserve', B, UB); await evidence(A); await evidence(B, { id: 'event-b' });
    const other = connect(); await other.connect();
    try { const outcomes = await Promise.all([call('reconcile'), call('reconcile', B, UB, 'endpoint-a', other)]); assert.deepEqual(outcomes.map((r) => r.status).sort(), ['evidence_matched', 'manual_review']); }
    finally { await other.end(); }
  });
  await test('rollback leaves no identity or orphan session', async () => {
    await db.query('BEGIN'); await call('reserve'); await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_customer_links')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM ycloud_onboarding_sessions')).rows[0].n, 0);
  });
  for (const role of ['anon', 'authenticated']) {
    await test(`${role} cannot call customer link RPCs or read private tables`, async () => {
      await call('reserve'); await db.query(`SET ROLE ${role}`);
      try {
        for (const operation of ['reserve', 'reconcile', 'get']) await assert.rejects(call(operation), (error) => error.code === '42501');
        for (const table of tables) await assert.rejects(db.query(`SELECT * FROM ${table}`), (error) => error.code === '42501');
      } finally { await db.query('RESET ROLE'); }
    });
    await test(`RLS denies ${role} even after accidental table grants`, async () => {
      await call('reserve'); await db.query(`GRANT SELECT ON ycloud_customer_links,ycloud_onboarding_sessions TO ${role}`); await db.query(`SET ROLE ${role}`);
      try { for (const table of tables.slice(0, 2)) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0); }
      finally { await db.query('RESET ROLE'); await db.query(`REVOKE SELECT ON ycloud_customer_links,ycloud_onboarding_sessions FROM ${role}`); }
    });
  }
  await test('service role uses scoped RPC but cannot rewrite or delete identities', async () => {
    await db.query('SET ROLE service_role');
    try {
      assert.equal((await call('reserve')).status, 'reserved');
      await assert.rejects(db.query("UPDATE ycloud_customer_links SET account_id=$1", [B]), (error) => error.code === '42501');
      await assert.rejects(db.query('DELETE FROM ycloud_onboarding_sessions'), (error) => error.code === '42501');
      await assert.rejects(call('get', A, UB), (error) => error.code === 'YC403');
    } finally { await db.query('RESET ROLE'); }
  });
  console.log(JSON.stringify({ passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results }, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  if (db) await db.end();
  if (created) await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);
  await admin.end();
}
