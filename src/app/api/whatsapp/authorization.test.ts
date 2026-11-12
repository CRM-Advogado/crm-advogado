import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@/lib/supabase/server';
import type { AccountRole } from '@/lib/auth/roles';
import { POST as broadcast } from './broadcast/route';
import { DELETE as resetConfig, GET as getConfig, POST as saveConfig } from './config/route';
import { GET as verifyRegistration } from './config/verify-registration/route';
import { POST as react } from './react/route';
import { POST as send } from './send/route';
import { DELETE as deleteTemplate, PATCH as editTemplate } from './templates/[id]/route';
import { POST as submitTemplate } from './templates/submit/route';
import { POST as syncTemplates } from './templates/sync/route';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'test-token' }));

const providerFetch = vi.fn<typeof fetch>();
const accountId = 'account-1';
const userId = 'user-1';
const config = {
  id: 'config-1',
  account_id: accountId,
  phone_number_id: 'phone-1',
  access_token: 'encrypted-test-token',
};

function request(body: unknown = {}) {
  return new Request('https://crm.example.test/api/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockSession(
  role: AccountRole | null,
  rows: Record<string, Record<string, unknown> | null> = {},
) {
  const filters: Array<[table: string, column: string, value: unknown]> = [];
  const from = vi.fn((table: string) => {
    const result = () => ({
      data: table === 'profiles'
        ? { account_id: accountId, account_role: role }
        : table === 'accounts'
          ? { id: accountId, name: 'Test account' }
          : rows[table] ?? null,
      error: null,
    });
    const builder = {
      select: () => builder,
      eq(column: string, value: unknown) {
        filters.push([table, column, value]);
        return builder;
      },
      maybeSingle: async () => result(),
      single: async () => result(),
      upsert: async () => ({ error: null }),
    };
    return builder;
  });
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: role ? { id: userId } : null }, error: null }),
    },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { from, filters };
}

const messaging = [
  ['send', () => send(request())],
  ['broadcast', () => broadcast(request())],
  ['react', () => react(request())],
] as const;

const templateContext = { params: Promise.resolve({ id: '26d136ea-e2dc-4b0c-98e9-04c79e5c3ae9' }) };
const settings = [
  ['read config', getConfig],
  ['save config', () => saveConfig(request())],
  ['reset config', resetConfig],
  ['verify registration', verifyRegistration],
  ['sync templates', syncTemplates],
  ['submit template', () => submitTemplate(request())],
  ['edit template', () => editTemplate(request(), templateContext)],
  ['delete template', () => deleteTemplate(request(), templateContext)],
] as const;

beforeEach(() => {
  providerFetch.mockReset();
  vi.stubGlobal('fetch', providerFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('WhatsApp route authorization before external effects', () => {
  it.each(messaging)('blocks a viewer from %s', async (_name, invoke) => {
    const { from } = mockSession('viewer');
    expect((await invoke()).status).toBe(403);
    expect(from.mock.calls.map(([table]) => table)).toEqual(['profiles', 'accounts']);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(settings)('requires an admin to %s', async (_name, invoke) => {
    const { from } = mockSession('agent');
    expect((await invoke()).status).toBe(403);
    expect(from.mock.calls.map(([table]) => table)).toEqual(['profiles', 'accounts']);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([...messaging, ...settings])('requires a session to %s', async (_name, invoke) => {
    const { from } = mockSession(null);
    expect((await invoke()).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('allows an agent to broadcast using the config and templates scoped to their account', async () => {
    const { filters } = mockSession('agent', { whatsapp_config: config });
    providerFetch.mockResolvedValueOnce(Response.json({ messages: [{ id: 'wamid-1' }] }));

    const response = await broadcast(request({
      phone_numbers: ['+15551234567'],
      template_name: 'order_update',
      account_id: 'untrusted-account',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: 1, failed: 0 });
    expect(filters).toContainEqual(['whatsapp_config', 'account_id', accountId]);
    expect(filters).toContainEqual(['message_templates', 'account_id', accountId]);
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('does not send a reaction if the conversation is not visible in the agent account', async () => {
    const { filters, from } = mockSession('agent', {
      messages: { id: 'message-1', message_id: 'wamid-1', conversation_id: 'other-conversation' },
    });

    const response = await react(request({ message_id: 'message-1', emoji: '👍' }));

    expect(response.status).toBe(404);
    expect(filters).toContainEqual(['conversations', 'id', 'other-conversation']);
    expect(filters).toContainEqual(['conversations', 'account_id', accountId]);
    expect(from).not.toHaveBeenCalledWith('whatsapp_config');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'] as const)('allows an %s to check the account configuration', async (role) => {
    const { filters } = mockSession(role, { whatsapp_config: config });
    providerFetch.mockResolvedValueOnce(Response.json({ id: config.phone_number_id }));

    const response = await getConfig();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true });
    expect(filters).toContainEqual(['whatsapp_config', 'account_id', accountId]);
    expect(providerFetch).toHaveBeenCalledOnce();
  });
});
