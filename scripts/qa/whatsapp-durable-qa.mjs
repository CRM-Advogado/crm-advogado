import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const { Client } = pg;
const settings = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55483),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
};
assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(settings.host),
  'QA requires a local disposable PostgreSQL'
);
const admin = new Client({
  ...settings,
  database: process.env.PGDATABASE || 'postgres',
});
const database = `whatsapp_durable_qa_${Date.now()}`;
assert.match(database, /^whatsapp_durable_qa_[0-9]+$/);
const connection = () => new Client({ ...settings, database });
const A = '10000000-0000-0000-0000-000000000001',
  B = '10000000-0000-0000-0000-000000000002';
const CA = '20000000-0000-0000-0000-000000000001',
  CB = '20000000-0000-0000-0000-000000000002';
const U = '30000000-0000-0000-0000-000000000001';
let db;
const results = [];
const fixture = `
CREATE TABLE public.whatsapp_config(id uuid primary key,account_id uuid not null UNIQUE,user_id uuid not null,phone_number_id text not null UNIQUE,waba_id text,status text not null CHECK(status IN('connected','disconnected')));
CREATE TABLE public.contacts(id uuid primary key default gen_random_uuid(), account_id uuid not null,user_id uuid not null,phone text not null,phone_normalized text GENERATED ALWAYS AS(regexp_replace(phone,'[^0-9]','','g')) STORED,name text,first_seen_at timestamptz,updated_at timestamptz,ad_source_id text,ad_source_type text,ad_source_url text,ad_headline text,ctwa_clid text,UNIQUE(account_id,phone_normalized));
CREATE TABLE public.conversations(id uuid primary key default gen_random_uuid(),account_id uuid not null,user_id uuid not null,contact_id uuid not null references contacts(id),status text not null CHECK(status IN('open','pending','closed')),unread_count integer default0,last_message_at timestamptz,last_message_text text,updated_at timestamptz,UNIQUE(account_id,contact_id));
CREATE TABLE public.messages(id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id),sender_type text not null CHECK(sender_type IN('customer','agent','bot')),content_type text not null CHECK(content_type IN('text','image','document','audio','video','location','template','interactive')),content_text text,media_url text,message_id text,status text not null CHECK(status IN('sending','sent','delivered','read','failed')),created_at timestamptz DEFAULTnow(),reply_to_message_id uuid references messages(id),interactive_reply_id text);
CREATE TABLE public.message_reactions(id uuid primary key default gen_random_uuid(),message_id uuid not null references messages(id),conversation_id uuid not null references conversations(id),actor_type text,actor_id uuid,emoji text,UNIQUE(message_id,actor_type,actor_id));
CREATE TABLE public.broadcasts(id uuid primary key default gen_random_uuid(),account_id uuid not null);
CREATE TABLE public.broadcast_recipients(id uuid primary key default gen_random_uuid(),broadcast_id uuid references broadcasts(id),contact_id uuid references contacts(id),whatsapp_message_id text,status text,created_at timestamptz default now(),sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,replied_at timestamptz);
CREATE TABLE public.message_templates(id uuid primary key default gen_random_uuid(),account_id uuid not null,meta_template_id text,status text CHECK(status IN('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION')),rejection_reason text,submission_error text,quality_score text CHECK(quality_score IS NULL OR quality_score IN('GREEN','YELLOW','RED')));
`
  .replaceAll('default0', 'default 0')
  .replaceAll('DEFAULTnow()', 'DEFAULT now()');
function item(key, account = A, kind = 'message', payload = {}) {
  return {
    account_id: account,
    connection_id: account === A ? CA : CB,
    phone_number_id: account === A ? 'phone-a' : 'phone-b',
    waba_id: account === A ? 'waba-a' : 'waba-b',
    event_key: key,
    event_kind: kind,
    payload: {
      phone: '5511999999999',
      name: 'Synthetic QA',
      message_id: key,
      occurred_at: '2026-10-16T12:00:00Z',
      content_type: 'text',
      content_text: 'Synthetic only',
      ...payload,
    },
  };
}
async function enqueue(events, client = db) {
  return (
    await client.query(
      'SELECT public.enqueue_whatsapp_ingress($1::jsonb) result',
      [JSON.stringify(events)]
    )
  ).rows[0].result;
}
async function claim(client = db) {
  return (
    await client.query('SELECT * FROM public.claim_whatsapp_ingress(50,10)')
  ).rows;
}
async function materialize(row, client = db, contact = null) {
  return client.query(
    'SELECT public.materialize_whatsapp_ingress($1,$2,$3) result',
    [row.id, row.claim_token, contact]
  );
}
async function materializeAll() {
  for (let attempts = 0; attempts < 50; attempts++) {
    const rows = await claim();
    if (!rows.length) return;
    for (const row of rows) await materialize(row);
  }
  throw new Error('QA materialization did not drain');
}
async function reset() {
  await db.query(
    'TRUNCATE public.whatsapp_ingress_outbox,public.whatsapp_ingress_events,public.message_reactions,public.messages,public.broadcast_recipients,public.broadcasts,public.conversations,public.contacts,public.message_templates,public.whatsapp_config'
  );
  await db.query(
    "INSERT INTO whatsapp_config VALUES($1,$2,$3,'phone-a','waba-a','connected'),($4,$5,$3,'phone-b','waba-b','connected')",
    [CA, A, U, CB, B]
  );
}
async function test(name, fn) {
  await reset();
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    await db.query('ROLLBACK');
    results.push({ name, passed: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
try {
  await admin.connect();
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;END $$`
  );
  await admin.query(`CREATE DATABASE ${database}`);
  db = connection();
  await db.connect();
  await db.query(fixture);
  const migration = await readFile(
    new URL(
      '../../supabase/migrations/045_whatsapp_durable_ingress.sql',
      import.meta.url
    ),
    'utf8'
  );
  await db.query(migration);
  await test('migration can be reapplied', async () => {
    await db.query(migration);
  });
  await test('duplicate concurrent enqueue creates one inbox row', async () => {
    const other = connection();
    await other.connect();
    try {
      await Promise.all([
        enqueue([item('dupe')]),
        enqueue([item('dupe')], other),
      ]);
    } finally {
      await other.end();
    }
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM whatsapp_ingress_events'))
        .rows[0].n,
      1
    );
  });
  await test('mixed account envelope rolls back all items on invalid binding', async () => {
    await assert.rejects(
      enqueue([item('good'), { ...item('bad', B), phone_number_id: 'wrong' }])
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM whatsapp_ingress_events'))
        .rows[0].n,
      0
    );
  });
  await test('same event identity with changed payload is rejected', async () => {
    await enqueue([item('collision')]);
    await assert.rejects(
      enqueue([item('collision', A, 'message', { content_text: 'DIFFERENT' })])
    );
  });
  await test('ledger still detects changed payload after payload purge', async () => {
    await enqueue([item('collision')]);
    await materialize((await claim())[0]);
    await assert.rejects(
      enqueue([item('collision', A, 'message', { content_text: 'DIFFERENT' })])
    );
  });
  await test('parallel claimers get disjoint reservations', async () => {
    await enqueue(
      Array.from({ length: 6 }, (_, i) => item(`claim-${i}`, i % 2 ? B : A))
    );
    const other = connection();
    await other.connect();
    try {
      await db.query('BEGIN');
      const first = (
        await db.query('SELECT * FROM claim_whatsapp_ingress(1,10)')
      ).rows;
      const second = (
        await other.query('SELECT * FROM claim_whatsapp_ingress(1,10)')
      ).rows;
      assert.equal(first.length, 1);
      assert.equal(second.length, 1);
      assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 2);
      assert.equal(
        new Set([...first, ...second].map((r) => r.connection_id)).size,
        2
      );
      await db.query('COMMIT');
    } finally {
      await db.query('ROLLBACK');
      await other.end();
    }
  });
  await test('expired claim is fenced after another worker reclaims', async () => {
    await enqueue([item('fence')]);
    const old = (await claim())[0];
    await db.query(
      "UPDATE whatsapp_ingress_events SET lease_until=clock_timestamp()-interval'1 second'"
    );
    const current = (await claim())[0];
    assert.notEqual(old.claim_token, current.claim_token);
    await assert.rejects(materialize(old));
    await materialize(current);
  });
  await test('materialization rollback keeps payload and produces no effects', async () => {
    await enqueue([item('rollback')]);
    const row = (await claim())[0];
    await db.query('BEGIN');
    await materialize(row);
    await db.query('ROLLBACK');
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
      0
    );
    const stored = (await db.query('SELECT * FROM whatsapp_ingress_events'))
      .rows[0];
    assert.equal(stored.state, 'processing');
    assert.ok(stored.payload);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM whatsapp_ingress_outbox'))
        .rows[0].n,
      0
    );
  });
  await test('different events same sender materialize one contact and conversation', async () => {
    await enqueue([item('one'), item('two')]);
    await materializeAll();
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM contacts')).rows[0].n,
      1
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM conversations')).rows[0].n,
      1
    );
    assert.equal(
      (await db.query('SELECT unread_count FROM conversations')).rows[0]
        .unread_count,
      2
    );
  });
  await test('caller-supplied contact cannot redirect a different sender phone', async () => {
    const contact = (
      await db.query(
        "INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,'5511222222222') RETURNING id",
        [A, U]
      )
    ).rows[0];
    await enqueue([item('contact-scope')]);
    await assert.rejects(materialize((await claim())[0], db, contact.id));
  });
  await test('config reassignment cancels accepted event without moving accounts', async () => {
    await enqueue([item('binding')]);
    const row = (await claim())[0];
    await db.query('DELETE FROM whatsapp_config WHERE id=$1', [CB]);
    await db.query('UPDATE whatsapp_config SET account_id=$1 WHERE id=$2', [
      B,
      CA,
    ]);
    await materialize(row);
    const saved = (await db.query('SELECT * FROM whatsapp_ingress_events'))
      .rows[0];
    assert.equal(saved.account_id, A);
    assert.equal(saved.state, 'cancelled');
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
      0
    );
  });
  await test('template lifecycle status cannot affect another account with same external ID', async () => {
    await db.query(
      "INSERT INTO message_templates(account_id,meta_template_id,status) VALUES($1,'same','PENDING'),($2,'same','PENDING')",
      [A, B]
    );
    await enqueue([
      item('template', A, 'template_status', {
        template_id: 'same',
        status: 'APPROVED',
      }),
    ]);
    await materialize((await claim())[0]);
    assert.equal(
      (
        await db.query(
          'SELECT status FROM message_templates WHERE account_id=$1',
          [B]
        )
      ).rows[0].status,
      'PENDING'
    );
    assert.equal(
      (
        await db.query(
          'SELECT status FROM message_templates WHERE account_id=$1',
          [A]
        )
      ).rows[0].status,
      'APPROVED'
    );
  });
  await test('started outbox is uncertain after expiry and never resent', async () => {
    await enqueue([item('outbox')]);
    await materialize((await claim())[0]);
    const row = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(10,10)')
    ).rows[0];
    const payload = (
      await db.query('SELECT start_whatsapp_ingress_outbox($1,$2) p', [
        row.id,
        row.claim_token,
      ])
    ).rows[0].p;
    assert.ok(payload);
    await db.query(
      "UPDATE whatsapp_ingress_outbox SET lease_until=clock_timestamp()-interval'1 second'"
    );
    assert.equal(
      (await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(10,10)'))
        .rows.length,
      0
    );
    assert.equal(
      (await db.query('SELECT state FROM whatsapp_ingress_outbox')).rows[0]
        .state,
      'uncertain'
    );
    assert.equal(
      (
        await db.query(
          'SELECT finish_whatsapp_ingress_outbox($1,$2,true) done',
          [row.id, row.claim_token]
        )
      ).rows[0].done,
      false
    );
  });
  await test('successful materialization purges inbox payload but retains ledger', async () => {
    await enqueue([item('purge')]);
    await materialize((await claim())[0]);
    const row = (await db.query('SELECT * FROM whatsapp_ingress_events'))
      .rows[0];
    assert.equal(row.state, 'completed');
    assert.equal(row.payload, null);
    assert.equal(row.event_key, 'purge');
  });
  await test('browser roles cannot read payload or execute worker RPC', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          db.query('SELECT payload FROM public.whatsapp_ingress_events'),
          (e) => e.code === '42501'
        );
        await assert.rejects(
          db.query('SELECT * FROM public.claim_whatsapp_ingress(10,10)'),
          (e) => e.code === '42501'
        );
      } finally {
        await db.query('RESET ROLE');
      }
    }
  });
  await test('service worker can claim while RPC search path is pinned', async () => {
    await enqueue([item('service')]);
    await db.query('SET ROLE service_role');
    try {
      assert.equal((await claim()).length, 1);
    } finally {
      await db.query('RESET ROLE');
    }
    const fns = (
      await db.query(
        "SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='claim_whatsapp_ingress'"
      )
    ).rows;
    assert.equal(fns[0].prosecdef, true);
    assert.ok(fns[0].proconfig.includes('search_path=public, pg_temp'));
  });
  await test('wall-clock expiry fences a claim inside an old transaction', async () => {
    await enqueue([item('wallclock')]);
    const row = (await claim())[0];
    await db.query('BEGIN');
    try {
      await db.query(
        "UPDATE whatsapp_ingress_events SET lease_until=clock_timestamp()+interval'100 milliseconds'"
      );
      await db.query('SELECT pg_sleep(0.15)');
      await assert.rejects(materialize(row));
    } finally {
      await db.query('ROLLBACK');
    }
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
      0
    );
  });
  await test('expiry while waiting for config lock rolls back all materialization', async () => {
    await enqueue([item('wait-binding')]);
    const row = (await claim())[0];
    await db.query(
      "UPDATE whatsapp_ingress_events SET lease_until=clock_timestamp()+interval'200 milliseconds'"
    );
    const other = connection();
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        'SELECT * FROM whatsapp_config WHERE id=$1 FOR UPDATE',
        [CA]
      );
      const operation = materialize(row).then(
        () => ({ passed: true }),
        (error) => ({ error })
      );
      await other.query('SELECT pg_sleep(0.3)');
      await other.query('COMMIT');
      const outcome = await operation;
      assert.ok(outcome.error, 'expired materialization must reject');
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
        0
      );
    } finally {
      await other.query('ROLLBACK');
      await other.end();
    }
  });
  await test('binding cannot be reassigned before materialization transaction commits', async () => {
    await enqueue([item('binding-lock')]);
    const row = (await claim())[0];
    const other = connection();
    await other.connect();
    await db.query('BEGIN');
    try {
      await materialize(row);
      await other.query("SET lock_timeout='100ms'");
      await assert.rejects(
        other.query('UPDATE whatsapp_config SET account_id=$1 WHERE id=$2', [
          B,
          CA,
        ]),
        (error) => error.code === '55P03'
      );
    } finally {
      await db.query('ROLLBACK');
      await other.end();
    }
  });
  await test('a failed SQL materialization rolls back contact and conversation creation', async () => {
    await enqueue([
      item('bad-content', A, 'message', { content_type: 'invalid' }),
    ]);
    const row = (await claim())[0];
    await assert.rejects(materialize(row), (error) => error.code === '23514');
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM contacts')).rows[0].n,
      0
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM conversations')).rows[0].n,
      0
    );
    assert.ok(
      (await db.query('SELECT payload FROM whatsapp_ingress_events')).rows[0]
        .payload
    );
  });
  await test('two consumers cannot both start the same outbox intention', async () => {
    await enqueue([item('single-start')]);
    await materialize((await claim())[0]);
    const other = connection();
    await other.connect();
    try {
      const [a, b] = await Promise.all([
        db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
        other.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
      ]);
      assert.equal(a.rows.length + b.rows.length, 1);
      const row = [...a.rows, ...b.rows][0];
      await db.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
        row.id,
        row.claim_token,
      ]);
      await assert.rejects(
        other.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
          row.id,
          row.claim_token,
        ])
      );
      await db.query('SELECT finish_whatsapp_ingress_outbox($1,$2,false)', [
        row.id,
        row.claim_token,
      ]);
      assert.equal(
        (await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'))
          .rows.length,
        0
      );
      assert.equal(
        (await db.query('SELECT state FROM whatsapp_ingress_outbox')).rows[0]
          .state,
        'uncertain'
      );
    } finally {
      await other.end();
    }
  });
  await test('successful outbox completion purges only its completed payload', async () => {
    await enqueue([item('complete-outbox')]);
    await materialize((await claim())[0]);
    const row = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)')
    ).rows[0];
    await db.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
      row.id,
      row.claim_token,
    ]);
    assert.equal(
      (
        await db.query(
          'SELECT finish_whatsapp_ingress_outbox($1,$2,true) result',
          [row.id, row.claim_token]
        )
      ).rows[0].result,
      true
    );
    const stored = (
      await db.query('SELECT state,payload FROM whatsapp_ingress_outbox')
    ).rows[0];
    assert.equal(stored.state, 'completed');
    assert.equal(stored.payload, null);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM whatsapp_ingress_events'))
        .rows[0].n,
      1
    );
  });
  await test('replay after materialization cannot duplicate unread or outbox', async () => {
    const event = item('replay-completed');
    await enqueue([event]);
    await materialize((await claim())[0]);
    assert.equal((await enqueue([event])).inserted, 0);
    assert.equal((await claim()).length, 0);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
      1
    );
    assert.equal(
      (await db.query('SELECT unread_count FROM conversations')).rows[0]
        .unread_count,
      1
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM whatsapp_ingress_outbox'))
        .rows[0].n,
      1
    );
  });
  await test('deleting a connection preserves accepted work and cancels materialization', async () => {
    await enqueue([item('connection-deleted')]);
    const row = (await claim())[0];
    await db.query('DELETE FROM whatsapp_config WHERE id=$1', [CA]);
    await materialize(row);
    const stored = (
      await db.query(
        'SELECT state,payload,account_id FROM whatsapp_ingress_events'
      )
    ).rows[0];
    assert.equal(stored.state, 'cancelled');
    assert.equal(stored.account_id, A);
    assert.ok(stored.payload);
  });
  await test('revoked binding prevents an already-created outbox from starting', async () => {
    await enqueue([item('outbox-revoked')]);
    await materialize((await claim())[0]);
    const row = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)')
    ).rows[0];
    await db.query(
      "UPDATE whatsapp_config SET status='disconnected' WHERE id=$1",
      [CA]
    );
    assert.equal(
      (
        await db.query('SELECT start_whatsapp_ingress_outbox($1,$2) payload', [
          row.id,
          row.claim_token,
        ])
      ).rows[0].payload,
      null
    );
    assert.equal(
      (await db.query('SELECT state FROM whatsapp_ingress_outbox')).rows[0]
        .state,
      'cancelled'
    );
  });
  await test('inspection is account scoped and never includes message content', async () => {
    await enqueue([item('inspect-a'), item('inspect-b', B)]);
    const result = (
      await db.query('SELECT inspect_whatsapp_ingress($1,50) result', [A])
    ).rows[0].result;
    assert.equal(result.inbox.length, 1);
    assert.equal(result.inbox[0].connection_id, CA);
    assert.ok(!JSON.stringify(result).includes('Synthetic only'));
    assert.ok(!('payload' in result.inbox[0]));
  });
  await test('outbox consumers cannot execute two intentions of the same connection concurrently', async () => {
    await enqueue([item('ordered-a'), item('ordered-b')]);
    await materializeAll();
    const other = connection();
    await other.connect();
    try {
      const [a, b] = await Promise.all([
        db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
        other.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
      ]);
      assert.equal(
        a.rows.length + b.rows.length,
        1,
        'same connection must have only one active pipeline'
      );
    } finally {
      await other.end();
    }
  });
  await test('outbox allows independent accounts to reserve concurrently', async () => {
    await enqueue([item('account-a-outbox'), item('account-b-outbox', B)]);
    await materializeAll();
    const other = connection();
    await other.connect();
    try {
      const [a, b] = await Promise.all([
        db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
        other.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)'),
      ]);
      assert.equal(a.rows.length + b.rows.length, 2);
      assert.equal(
        new Set([...a.rows, ...b.rows].map((row) => row.connection_id)).size,
        2
      );
    } finally {
      await other.end();
    }
  });
  await test('an uncertain intention blocks later intentions of the same connection', async () => {
    await enqueue([item('uncertain-first'), item('blocked-second')]);
    await materializeAll();
    const first = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)')
    ).rows[0];
    await db.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
      first.id,
      first.claim_token,
    ]);
    await db.query('SELECT finish_whatsapp_ingress_outbox($1,$2,false)', [
      first.id,
      first.claim_token,
    ]);
    assert.equal(
      (await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(10,10)'))
        .rows.length,
      0
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM whatsapp_ingress_outbox WHERE state='pending'"
        )
      ).rows[0].n,
      1
    );
  });
  await test('inbox FIFO gives creation and first-inbound flags to the first accepted event', async () => {
    await enqueue([item('fifo-first'), item('fifo-second')]);
    const first = (await claim())[0];
    assert.equal(first.event_key, 'fifo-first');
    const other = connection();
    await other.connect();
    try {
      assert.equal((await claim(other)).length, 0);
    } finally {
      await other.end();
    }
    await materialize(first);
    const second = (await claim())[0];
    assert.equal(second.event_key, 'fifo-second');
    await materialize(second);
    const payloads = (
      await db.query(
        'SELECT e.event_key,o.payload FROM whatsapp_ingress_events e JOIN whatsapp_ingress_outbox o ON o.event_id=e.id ORDER BY e.sequence_id'
      )
    ).rows;
    assert.equal(payloads[0].payload.first_inbound, true);
    assert.equal(payloads[0].payload.was_created, true);
    assert.equal(payloads[1].payload.first_inbound, false);
    assert.equal(payloads[1].payload.was_created, false);
  });
  await test('audited manual resolution unblocks later work without resending the uncertain intention', async () => {
    await enqueue([item('manual-first'), item('manual-next')]);
    await materializeAll();
    const first = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)')
    ).rows[0];
    await db.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
      first.id,
      first.claim_token,
    ]);
    await db.query('SELECT finish_whatsapp_ingress_outbox($1,$2,false)', [
      first.id,
      first.claim_token,
    ]);
    assert.equal(
      (
        await db.query(
          'SELECT resolve_whatsapp_ingress_uncertain($1,$2,$3,$4) result',
          [first.id, B, U, 'cancelled_without_retry']
        )
      ).rows[0].result,
      false
    );
    await assert.rejects(
      db.query('SELECT resolve_whatsapp_ingress_uncertain($1,$2,$3,$4)', [
        first.id,
        A,
        U,
        'retry',
      ])
    );
    assert.equal(
      (
        await db.query(
          'SELECT resolve_whatsapp_ingress_uncertain($1,$2,$3,$4) result',
          [first.id, A, U, 'cancelled_without_retry']
        )
      ).rows[0].result,
      true
    );
    const stored = (
      await db.query('SELECT * FROM whatsapp_ingress_outbox WHERE id=$1', [
        first.id,
      ])
    ).rows[0];
    assert.equal(stored.state, 'cancelled');
    assert.equal(stored.resolved_by, U);
    assert.ok(stored.resolved_at);
    assert.equal(stored.resolution, 'cancelled_without_retry');
    const next = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(10,10)')
    ).rows;
    assert.equal(next.length, 1);
    assert.notEqual(next[0].id, first.id);
  });
  await test('a row locked by a busy connection does not stall another account inbox', async () => {
    await enqueue([item('busy-first'), item('free-second', B)]);
    const other = connection();
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        "SELECT id FROM whatsapp_ingress_events WHERE event_key='busy-first' FOR UPDATE"
      );
      await db.query("SET lock_timeout='150ms'");
      const rows = await claim();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].connection_id, CB);
    } finally {
      await db.query("SET lock_timeout='0'");
      await other.query('ROLLBACK');
      await other.end();
    }
  });
  await test('a locked expired started outbox does not stall another account recovery', async () => {
    await enqueue([item('busy-outbox'), item('free-outbox', B)]);
    await materializeAll();
    const row = (
      await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(1,10)')
    ).rows[0];
    await db.query('SELECT start_whatsapp_ingress_outbox($1,$2)', [
      row.id,
      row.claim_token,
    ]);
    await db.query(
      "UPDATE whatsapp_ingress_outbox SET lease_until=clock_timestamp()-interval'1 second' WHERE id=$1",
      [row.id]
    );
    const other = connection();
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        'SELECT id FROM whatsapp_ingress_outbox WHERE id=$1 FOR UPDATE',
        [row.id]
      );
      await db.query("SET lock_timeout='150ms'");
      const rows = (
        await db.query('SELECT * FROM claim_whatsapp_ingress_outbox(10,10)')
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].connection_id, CB);
    } finally {
      await db.query("SET lock_timeout='0'");
      await other.query('ROLLBACK');
      await other.end();
    }
  });
  await test('manual cancellation audits a failed head and releases the next event without deleting payload', async () => {
    await enqueue([item('failed-head'), item('after-cancellation')]);
    const first = (await claim())[0];
    await db.query(
      "UPDATE whatsapp_ingress_events SET state='failed' WHERE id=$1",
      [first.id]
    );
    assert.equal((await claim()).length, 0);
    assert.equal(
      (
        await db.query('SELECT cancel_whatsapp_ingress($1,$2,$3) result', [
          first.id,
          B,
          U,
        ])
      ).rows[0].result,
      false
    );
    await assert.rejects(
      db.query('SELECT cancel_whatsapp_ingress($1,$2,$3)', [first.id, A, null])
    );
    assert.equal(
      (
        await db.query('SELECT cancel_whatsapp_ingress($1,$2,$3) result', [
          first.id,
          A,
          U,
        ])
      ).rows[0].result,
      true
    );
    const stored = (
      await db.query('SELECT * FROM whatsapp_ingress_events WHERE id=$1', [
        first.id,
      ])
    ).rows[0];
    assert.equal(stored.state, 'cancelled');
    assert.equal(stored.cancelled_by, U);
    assert.ok(stored.cancelled_at);
    assert.ok(stored.payload);
    const next = await claim();
    assert.equal(next.length, 1);
    assert.equal(next[0].event_key, 'after-cancellation');
  });
  await test('durable statuses are account scoped and cannot regress read to sent', async () => {
    await enqueue([item('status-seed-a'), item('status-seed-b', B)]);
    await materializeAll();
    await db.query(
      "INSERT INTO messages(conversation_id,sender_type,content_type,message_id,status) SELECT id,'agent','text','shared-status-id','sent' FROM conversations"
    );
    await enqueue([
      item('status-read', A, 'status', {
        message_id: 'shared-status-id',
        status: 'read',
      }),
      item('status-late-sent', A, 'status', {
        message_id: 'shared-status-id',
        status: 'sent',
      }),
    ]);
    await materializeAll();
    const rows = (
      await db.query(
        "SELECT c.account_id,m.status FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.message_id='shared-status-id'"
      )
    ).rows;
    assert.equal(rows.find((row) => row.account_id === A).status, 'read');
    assert.equal(rows.find((row) => row.account_id === B).status, 'sent');
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM whatsapp_ingress_outbox o JOIN whatsapp_ingress_events e ON e.id=o.event_id WHERE e.event_kind='status'"
        )
      ).rows[0].n,
      1
    );
  });
  await test('durable reactions target only the sender conversation without message or unread duplication', async () => {
    await enqueue([item('reaction-seed-a'), item('reaction-seed-b', B)]);
    await materializeAll();
    await db.query(
      "INSERT INTO messages(conversation_id,sender_type,content_type,message_id,status) SELECT id,'agent','text','shared-reaction-target','sent' FROM conversations"
    );
    await enqueue([
      item('reaction-add', A, 'reaction', {
        reaction_target_id: 'shared-reaction-target',
        emoji: '👍',
      }),
    ]);
    await materializeAll();
    const rows = (
      await db.query(
        'SELECT c.account_id,r.emoji FROM message_reactions r JOIN conversations c ON c.id=r.conversation_id'
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_id, A);
    assert.equal(rows[0].emoji, '👍');
    assert.equal(
      (
        await db.query(
          'SELECT unread_count FROM conversations WHERE account_id=$1',
          [A]
        )
      ).rows[0].unread_count,
      1
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,
      4
    );
    await enqueue([
      item('reaction-remove', A, 'reaction', {
        reaction_target_id: 'shared-reaction-target',
        emoji: '',
      }),
    ]);
    await materializeAll();
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM message_reactions')).rows[0]
        .n,
      0
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM whatsapp_ingress_outbox o JOIN whatsapp_ingress_events e ON e.id=o.event_id WHERE e.event_kind='reaction'"
        )
      ).rows[0].n,
      0
    );
  });
  await test('reply linkage never points at a message in another account conversation', async () => {
    await enqueue([item('reply-seed-a'), item('reply-seed-b', B)]);
    await materializeAll();
    await db.query(
      "INSERT INTO messages(conversation_id,sender_type,content_type,message_id,status) SELECT id,'agent','text','parent-only-b','sent' FROM conversations WHERE account_id=$1",
      [B]
    );
    await enqueue([
      item('reply-cross-account', A, 'message', {
        reply_to_provider_id: 'parent-only-b',
      }),
    ]);
    await materializeAll();
    assert.equal(
      (
        await db.query(
          "SELECT reply_to_message_id FROM messages WHERE message_id='reply-cross-account'"
        )
      ).rows[0].reply_to_message_id,
      null
    );
    const parent = (
      await db.query(
        "INSERT INTO messages(conversation_id,sender_type,content_type,message_id,status) SELECT id,'agent','text','parent-only-a','sent' FROM conversations WHERE account_id=$1 RETURNING id",
        [A]
      )
    ).rows[0];
    await enqueue([
      item('reply-same-account', A, 'message', {
        reply_to_provider_id: 'parent-only-a',
      }),
    ]);
    await materializeAll();
    assert.equal(
      (
        await db.query(
          "SELECT reply_to_message_id FROM messages WHERE message_id='reply-same-account'"
        )
      ).rows[0].reply_to_message_id,
      parent.id
    );
  });
  console.log(
    JSON.stringify(
      {
        database,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        results,
      },
      null,
      2
    )
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  if (db) await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH(FORCE)`);
  await admin.end();
}
