import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { PATCH } from './[id]/route'
import { POST as IMPORT } from './import/route'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: () => Response.json({}, { status: 403 }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))
vi.mock('@/lib/automations/reference-catalog', () => ({
  loadReferenceCatalog: () => ({
    tags: [], pipelines: [], stages: [], agents: [], customFields: [],
  }),
}))

const base = { name: 'Draft', trigger_type: 'new_message_received', is_active: false }
const message = { step_type: 'send_message', step_config: { text: 'Oi' } }
function depth(levels: number) {
  let step: Record<string, unknown> = message
  for (let i = 1; i < levels; i++) {
    step = {
      step_type: 'condition',
      step_config: { subject: 'message_content', operator: 'contains', operand: 'Oi' },
      branches: { yes: [step] },
    }
  }
  return step
}

const endpoints = [
  { name: 'POST', send: (body: string) => POST(new Request('http://localhost/api/automations', { method: 'POST', body })) },
  {
    name: 'PATCH',
    send: (body: string) => PATCH(
      new Request('http://localhost/api/automations/id', { method: 'PATCH', body }),
      { params: Promise.resolve({ id: 'automation-1' }) },
    ),
  },
  { name: 'import', send: (body: string) => IMPORT(new Request('http://localhost/api/automations/import', { method: 'POST', body })) },
]

function payload(name: string, automation: Record<string, unknown>) {
  return JSON.stringify(name === 'import' ? { automations: [automation] } : automation)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireRole.mockResolvedValue({ accountId: 'account-1', userId: 'user-1' })
  const existing = {
    id: 'automation-1', is_active: false, trigger_type: base.trigger_type,
    trigger_config: {}, updated_at: '2026-11-12T00:00:00.000Z',
  }
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: existing }) }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  mocks.from.mockReturnValue(query)
  mocks.rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'update_automation_tree' ? true : [{ id: 'automation-1' }],
  }))
})

describe.each(endpoints)('$name automation writes', ({ name, send }) => {
  it.each([
    ['101 steps', { steps: Array.from({ length: 101 }, () => message) }],
    ['11 nested levels', { steps: [depth(11)] }],
    ['unknown step type', { steps: [{ step_type: 'unknown', step_config: {} }] }],
    ['malformed configuration', { steps: [{ ...message, step_config: [] }] }],
    ['non-boolean activation', { is_active: 'false' }],
  ])('rejects %s before reading or writing a tree', async (_case, value) => {
    const response = await send(payload(name, { ...base, ...value }))
    expect(response.status).toBe(name === 'import' ? 422 : 400)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before accessing persistence', async () => {
    expect((await send('{')).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('counts UTF-8 bytes without a Content-Length header', async () => {
    const response = await send(payload(name, { ...base, description: 'é'.repeat(270_000) }))
    expect(response.status).toBe(413)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('accepts exactly 100 nodes and 10 levels, with generated step IDs', async () => {
    const steps = [
      { ...message, id: 'client-step-id' },
      ...Array.from({ length: 89 }, () => message),
      depth(10),
    ]
    const response = await send(payload(name, { ...base, id: 'client-automation-id', steps }))
    expect(response.status).toBe(name === 'PATCH' ? 200 : 201)
    expect(mocks.rpc).toHaveBeenCalledOnce()
    const [rpc, args] = mocks.rpc.mock.calls[0]
    const rows = rpc === 'update_automation_tree' ? args.p_steps : args.p_automations[0].steps
    expect(rows).toHaveLength(100)
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[91].parent_step_id).toBe(rows[90].id)
    expect(JSON.stringify(args)).not.toContain('client-step-id')
    expect(JSON.stringify(args)).not.toContain('client-automation-id')
  })
})

describe('builder draft and activation behavior', () => {
  it.each(endpoints.slice(0, 2))('allows an incomplete draft on $name but blocks activating it', async ({ name, send }) => {
    const draft = { ...base, steps: [{ step_type: 'send_message', step_config: {} }] }
    expect((await send(payload(name, draft))).status).toBe(name === 'POST' ? 201 : 200)
    mocks.rpc.mockClear()
    expect((await send(payload(name, { ...draft, is_active: true }))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('validates legacy flat references before persisting a normalized tree', async () => {
    const root = { step_type: 'condition', step_config: {}, branch: null, parent_index: null }
    const child = { ...message, branch: 'yes', parent_index: 0 }
    expect((await endpoints[0].send(payload('POST', { ...base, steps: [root, child] }))).status).toBe(201)
    const rows = mocks.rpc.mock.calls[0][1].p_automations[0].steps
    expect(rows[1].parent_step_id).toBe(rows[0].id)
    mocks.rpc.mockClear()
    const self = { ...root, parent_index: 0 }
    expect((await endpoints[0].send(payload('POST', { ...base, steps: [self] }))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns a conflict when a concurrent edit invalidates the PATCH snapshot', async () => {
    mocks.rpc.mockResolvedValue({ data: false })
    expect((await endpoints[1].send(payload('PATCH', { name: 'Other name' }))).status).toBe(409)
    expect(mocks.rpc).toHaveBeenCalledWith('update_automation_tree', expect.objectContaining({
      p_account_id: 'account-1',
      p_user_id: 'user-1',
      p_expected_updated_at: '2026-11-12T00:00:00.000Z',
      p_steps: null,
    }))
  })
})
