import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const account = '00000000-0000-0000-0000-000000000001'
const otherAccount = '00000000-0000-0000-0000-000000000002'
const user = '00000000-0000-0000-0000-000000000003'
const viewer = '00000000-0000-0000-0000-000000000004'
const stepId = '00000000-0000-0000-0000-000000000005'
const childId = '00000000-0000-0000-0000-000000000006'
const missingId = '00000000-0000-0000-0000-000000000007'
const step = { id: stepId, parent_step_id: null, branch: null, step_type: 'condition', step_config: {}, position: 0 }
const child = { ...step, id: childId, parent_step_id: stepId, branch: 'yes', step_type: 'send_message' }
const automation = { name: 'Draft', trigger_type: 'new_message_received', trigger_config: {}, is_active: false }

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE profiles (user_id uuid PRIMARY KEY, account_id uuid NOT NULL, account_role text NOT NULL);
    CREATE TABLE automations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, user_id uuid NOT NULL,
      name text NOT NULL, description text, trigger_type text NOT NULL,
      trigger_config jsonb NOT NULL, is_active boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE automation_steps (
      id uuid PRIMARY KEY, automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      parent_step_id uuid REFERENCES automation_steps(id) ON DELETE CASCADE,
      branch text CHECK (branch IN ('yes','no')), step_type text NOT NULL,
      step_config jsonb NOT NULL, position int NOT NULL
    );
    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
    CREATE TRIGGER set_updated_at BEFORE UPDATE ON automations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    GRANT SELECT, UPDATE ON profiles TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON automations, automation_steps TO service_role;
    INSERT INTO profiles VALUES ('${user}', '${account}', 'agent'), ('${viewer}', '${account}', 'viewer');
  `)
  await db.exec(readFileSync('supabase/migrations/056_automation_atomic_writes.sql', 'utf8'))
  await db.exec('SET ROLE service_role')
})

afterAll(async () => { await db?.close() })

function create(entries: unknown[], target = account, caller = user) {
  return db.query<{ id: string; revision: string }>(
    'SELECT id, updated_at::text AS revision FROM create_automation_trees($1, $2, $3)',
    [target, caller, JSON.stringify(entries)],
  )
}

function update(id: string, revision: string, fields: object, steps: unknown[] | null) {
  return db.query<{ updated: boolean }>(
    'SELECT update_automation_tree($1, $2, $3, $4, $5, $6) AS updated',
    [account, user, id, revision, JSON.stringify(fields), steps && JSON.stringify(steps)],
  )
}

describe('transactional automation RPCs', () => {
  it('keeps RPC execution private and enforces account membership and role', async () => {
    const privileges = await db.query<{ anon: boolean; member: boolean; server: boolean }>(
      "SELECT has_function_privilege('anon', 'create_automation_trees(uuid,uuid,jsonb)', 'execute') AS anon, " +
      "has_function_privilege('authenticated', 'update_automation_tree(uuid,uuid,uuid,timestamptz,jsonb,jsonb)', 'execute') AS member, " +
      "has_function_privilege('service_role', 'update_automation_tree(uuid,uuid,uuid,timestamptz,jsonb,jsonb)', 'execute') AS server",
    )
    expect(privileges.rows[0]).toEqual({ anon: false, member: false, server: true })
    await expect(create([{ ...automation, steps: [] }], otherAccount)).rejects.toThrow('automation_account_not_authorized')
    await expect(create([{ ...automation, steps: [] }], account, viewer)).rejects.toThrow('automation_account_not_authorized')
  })

  it('rolls back every parent and step when the last imported tree fails', async () => {
    await expect(create([
      { ...automation, steps: [step, child] },
      { ...automation, name: 'Invalid', steps: [{ ...step, id: missingId, branch: 'invalid' }] },
    ])).rejects.toThrow(/check constraint/)
    expect((await db.query('SELECT id FROM automations')).rows).toEqual([])
    expect((await db.query('SELECT id FROM automation_steps')).rows).toEqual([])
  })

  it('preserves the old tree on failure, rejects stale edits and clears steps atomically', async () => {
    const { id, revision } = (await create([{ ...automation, steps: [step, child] }])).rows[0]
    await expect(update(id, revision, { name: 'Invalid edit' }, [
      { ...child, id: missingId, parent_step_id: childId },
    ])).rejects.toThrow(/foreign key constraint/)
    expect((await db.query('SELECT name FROM automations WHERE id=$1', [id])).rows).toEqual([{ name: 'Draft' }])
    expect((await db.query('SELECT id FROM automation_steps WHERE automation_id=$1 ORDER BY id', [id])).rows)
      .toEqual([{ id: stepId }, { id: childId }])

    expect((await update(id, revision, { name: 'Renamed' }, null)).rows).toEqual([{ updated: true }])
    expect((await update(id, revision, { name: 'Stale edit' }, [])).rows).toEqual([{ updated: false }])
    const current = (await db.query<{ revision: string }>(
      'SELECT updated_at::text AS revision FROM automations WHERE id=$1', [id],
    )).rows[0].revision
    expect((await update(id, current, {}, [])).rows).toEqual([{ updated: true }])
    expect((await db.query('SELECT id FROM automation_steps WHERE automation_id=$1', [id])).rows).toEqual([])
  })
})
