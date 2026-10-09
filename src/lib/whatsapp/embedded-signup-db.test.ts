import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const U = '00000000-0000-0000-0000-000000000003';
let db: PGlite;
async function begin(account = A, state = 'state-a') {
  const result = await db.query<{ id: string }>(
    'SELECT begin_whatsapp_signup($1, $2, $3) AS id',
    [account, U, state]
  );
  return result.rows[0].id;
}
async function claim(id: string) {
  await db.query(
    "UPDATE whatsapp_signup_sessions SET status = 'processing' WHERE id = $1 AND status = 'pending'",
    [id]
  );
}
async function reserve(id: string, account = A, waba = '123', phone = '456') {
  return db.query('SELECT reserve_whatsapp_signup($1, $2, $3, $4, $5)', [
    id,
    account,
    U,
    waba,
    phone,
  ]);
}
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY);
    CREATE TABLE public.accounts(id UUID PRIMARY KEY);
    CREATE TABLE public.whatsapp_config(id UUID DEFAULT gen_random_uuid(), account_id UUID UNIQUE,
      user_id UUID, phone_number_id TEXT UNIQUE, waba_id TEXT, access_token TEXT NOT NULL, verify_token TEXT,
      status TEXT, connected_at TIMESTAMPTZ, registered_at TIMESTAMPTZ, subscribed_apps_at TIMESTAMPTZ, last_registration_error TEXT);
    INSERT INTO auth.users VALUES ('${U}'); INSERT INTO accounts VALUES ('${A}'), ('${B}');`);
  await db.exec(
    readFileSync('supabase/migrations/055_whatsapp_embedded_signup.sql', 'utf8')
  );
});
afterEach(async () => {
  await db.close();
});
describe('Embedded Signup migration and PostgreSQL integration', () => {
  it('can be reapplied safely', async () => {
    await db.exec(
      readFileSync(
        'supabase/migrations/055_whatsapp_embedded_signup.sql',
        'utf8'
      )
    );
    expect(await begin()).toBeTruthy();
  });
  it('blocks anonymous and authenticated RPC/table access', async () => {
    const result = await db.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('authenticated', 'begin_whatsapp_signup(uuid,uuid,text)', 'execute') AS allowed`
    );
    expect(result.rows[0].allowed).toBe(false);
    const rpc = await db.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('service_role', 'finish_whatsapp_signup(uuid,uuid,uuid,text,text)', 'execute') AS allowed`
    );
    expect(rpc.rows[0].allowed).toBe(true);
    await db.exec('SET ROLE authenticated');
    await expect(
      db.query('SELECT * FROM whatsapp_signup_sessions')
    ).rejects.toThrow('permission denied');
    await db.exec('RESET ROLE');
  });
  it('limits begin attempts persistently and never replaces an existing config', async () => {
    await begin();
    await expect(begin(A, 'state-two')).rejects.toThrow('signup_busy');
    await db.query(
      "INSERT INTO whatsapp_config(account_id, user_id, phone_number_id, access_token) VALUES ($1,$2,'111','original')",
      [B, U]
    );
    await expect(begin(B, 'state-b')).rejects.toThrow(
      'signup_already_connected'
    );
  });
  it('commits config and session completion together, and denies replay', async () => {
    const id = await begin();
    await claim(id);
    await reserve(id);
    await db.query(
      "SELECT finish_whatsapp_signup($1,$2,$3,'cipher-token','cipher-verify')",
      [id, A, U]
    );
    const result = await db.query<{ access_token: string; status: string }>(
      'SELECT access_token, status FROM whatsapp_config WHERE account_id=$1',
      [A]
    );
    expect(result.rows[0]).toEqual({
      access_token: 'cipher-token',
      status: 'connected',
    });
    await expect(
      db.query(
        "SELECT finish_whatsapp_signup($1,$2,$3,'replacement','verify')",
        [id, A, U]
      )
    ).rejects.toThrow('signup_session_invalid');
  });
  it('rejects an account mismatch and unclaimed/expired sessions', async () => {
    const id = await begin();
    await expect(reserve(id)).rejects.toThrow('signup_session_invalid');
    await claim(id);
    await expect(reserve(id, B)).rejects.toThrow('signup_session_invalid');
    await db.query(
      "UPDATE whatsapp_signup_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [id]
    );
    await expect(reserve(id)).rejects.toThrow('signup_session_invalid');
  });
  it('rejects a user mismatch', async () => {
    const id = await begin();
    await claim(id);
    await expect(
      db.query('SELECT reserve_whatsapp_signup($1,$2,$3,$4,$5)', [
        id,
        A,
        B,
        '123',
        '456',
      ])
    ).rejects.toThrow('signup_session_invalid');
  });
  it('prevents two offices reserving the same WABA or phone', async () => {
    const a = await begin();
    const b = await begin(B, 'state-b');
    await claim(a);
    await claim(b);
    await reserve(a);
    await expect(reserve(b, B)).rejects.toThrow('duplicate key');
    await expect(reserve(b, B, '999', '456')).rejects.toThrow('duplicate key');
    await reserve(b, B, '999', '888');
  });
  it('rejects a WABA already saved for another account', async () => {
    await db.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token) VALUES ($1,$2,'999','123','existing')",
      [B, U]
    );
    const id = await begin();
    await claim(id);
    await expect(reserve(id)).rejects.toThrow('signup_asset_conflict');
  });
  it('recovers expired reservations from a crashed instance', async () => {
    const a = await begin();
    await claim(a);
    await reserve(a);
    await db.query(
      "UPDATE whatsapp_signup_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [a]
    );
    const b = await begin(B, 'state-b');
    await claim(b);
    await reserve(b, B);
    const result = await db.query<{ status: string }>(
      'SELECT status FROM whatsapp_signup_sessions WHERE id=$1',
      [a]
    );
    expect(result.rows[0].status).toBe('failed');
  });
  it('rolls back completion if a config was created concurrently', async () => {
    const id = await begin();
    await claim(id);
    await reserve(id);
    await db.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES ($1,$2,'777','original')",
      [A, U]
    );
    await expect(
      db.query(
        "SELECT finish_whatsapp_signup($1,$2,$3,'replacement','verify')",
        [id, A, U]
      )
    ).rejects.toThrow('duplicate key');
    const result = await db.query<{ access_token: string }>(
      'SELECT access_token FROM whatsapp_config WHERE account_id=$1',
      [A]
    );
    expect(result.rows[0].access_token).toBe('original');
    expect(
      (
        await db.query<{ status: string }>(
          'SELECT status FROM whatsapp_signup_sessions WHERE id=$1',
          [id]
        )
      ).rows[0].status
    ).toBe('processing');
  });
});
