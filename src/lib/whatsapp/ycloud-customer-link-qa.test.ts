import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runYCloudCustomerLink, assertYCloudMutationOrigin } from './ycloud-customer-link';
import { GET, POST } from '@/app/api/whatsapp/ycloud/onboarding/route';
import { POST as reconcilePOST } from '@/app/api/whatsapp/ycloud/onboarding/reconcile/route';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/auth/account', async (original) => ({ ...await original<typeof import('@/lib/auth/account')>(), requireRole: mocks.auth }));

const context = { accountId: '10000000-0000-0000-0000-000000000001', userId: '20000000-0000-0000-0000-000000000001' };
const config = { enabled: true, endpointNamespace: 'endpoint-a' };
const reserved = { status: 'reserved', sessionId: '30000000-0000-0000-0000-000000000001', expiresAt: '2026-10-28T12:00:00Z', operational: false, coexistenceVerified: false };
function db(data: unknown = reserved, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const factory = vi.fn(() => ({ rpc }) as unknown as SupabaseClient);
  return { rpc, factory };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.auth.mockReset(); mocks.admin.mockReset(); });

describe('independent YCloud customer link boundary QA', () => {
  it.each(['reserve', 'reconcile', 'status'] as const)('disabled %s never initializes a database', async (operation) => {
    const database = db();
    await expect(runYCloudCustomerLink(operation, context, { ...config, enabled: false }, database.factory)).rejects.toMatchObject({ status: 404 });
    expect(database.factory).not.toHaveBeenCalled();
  });
  it.each(['', 'namespace/escape', 'x'.repeat(101), ' namespace'])('rejects invalid server namespace %j before database', async (endpointNamespace) => {
    const database = db();
    await expect(runYCloudCustomerLink('reserve', context, { ...config, endpointNamespace }, database.factory)).rejects.toMatchObject({ status: 503 });
    expect(database.factory).not.toHaveBeenCalled();
  });
  it.each([
    ['reserve', 'reserve_ycloud_onboarding'],
    ['reconcile', 'reconcile_ycloud_onboarding'],
    ['status', 'get_ycloud_onboarding_status'],
  ] as const)('%s sends only authenticated actor/account and server namespace to its RPC', async (operation, rpcName) => {
    const database = db();
    await runYCloudCustomerLink(operation, context, config, database.factory);
    expect(database.rpc).toHaveBeenCalledExactlyOnceWith(rpcName, {
      p_account_id: context.accountId, p_actor_id: context.userId, p_endpoint_namespace: 'endpoint-a',
    });
  });
  it('does not finish reserve while its transaction is unconfirmed', async () => {
    const database = db(); let resolve!: (value: unknown) => void;
    database.rpc.mockImplementation(() => new Promise((done) => { resolve = done; }));
    let finished = false;
    const result = runYCloudCustomerLink('reserve', context, config, database.factory).then(() => { finished = true; });
    await vi.waitFor(() => expect(database.rpc).toHaveBeenCalled());
    expect(finished).toBe(false);
    resolve({ data: reserved, error: null });
    await result;
    expect(finished).toBe(true);
  });
  it.each([null, {}, { status: 'connected' }, { status: 'reserved', operational: true }, { status: 'reserved', coexistenceVerified: true }])('refuses an invalid or operational RPC result %j', async (response) => {
    const database = db(response);
    await expect(runYCloudCustomerLink('reserve', context, config, database.factory)).rejects.toMatchObject({ status: 503 });
  });
  it('does not leak provider identifiers or private arbitrary fields', async () => {
    const database = db({ ...reserved, partnerCustomerId: 'private-partner', wabaId: 'private-waba', namespace: 'private-namespace', secret: 'private-secret' });
    const result = await runYCloudCustomerLink('status', context, config, database.factory);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
    expect(result).toMatchObject({ status: 'reserved', operational: false, coexistenceVerified: false });
  });
  it('returns stable errors without exposing database bodies', async () => {
    const database = db(null, { code: 'XX000', message: 'private-database-body' });
    await expect(runYCloudCustomerLink('reserve', context, config, database.factory)).rejects.toMatchObject({ status: 503 });
    await expect(runYCloudCustomerLink('reserve', context, config, database.factory)).rejects.not.toThrow('private-database-body');
  });
});

describe('independent YCloud scoped HTTP and origin QA', () => {
  const site = 'https://crm.example';
  function request(origin: string | null = site, body?: string, extraHeaders: Record<string, string> = {}) {
    return new Request('https://forged-host.invalid/api/whatsapp/ycloud/onboarding?account_id=forged&partnerCustomerId=forged&namespace=forged', {
      method: 'POST', body,
      headers: { ...(origin === null ? {} : { origin }), ...extraHeaders },
    });
  }
  function enable() {
    vi.stubEnv('YCLOUD_CUSTOMER_LINK_ENABLED', 'true'); vi.stubEnv('YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE', 'endpoint-a'); vi.stubEnv('NEXT_PUBLIC_SITE_URL', site);
    mocks.auth.mockResolvedValue(context);
    const database = db(); mocks.admin.mockImplementation(database.factory); return database;
  }
  it('uses canonical origin rather than request host or forwarded headers', () => {
    expect(() => assertYCloudMutationOrigin(request(site, undefined, { 'x-forwarded-host': 'evil.invalid' }), site)).not.toThrow();
    expect(() => assertYCloudMutationOrigin(request('https://forged-host.invalid'), site)).toThrow();
  });
  it.each([null, 'null', 'https://evil.invalid', 'https://crm.example.evil.invalid', 'http://crm.example'])('rejects mutation origin %j before persistence', async (origin) => {
    enable(); const result = await POST(request(origin)); expect(result.status).toBe(403); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(['cross-site', 'same-site'])('rejects sec-fetch-site %s', async (value) => {
    enable(); const result = await POST(request(site, undefined, { 'sec-fetch-site': value })); expect(result.status).toBe(403); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(['', 'http://public.example', 'https://crm.example/path', 'https://crm.example?x=1', 'https://user:password@crm.example'])('rejects untrusted canonical configuration %j', async (value) => {
    enable(); vi.stubEnv('NEXT_PUBLIC_SITE_URL', value); const result = await POST(request()); expect(result.status).toBe(503); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('rejects browser selectors in JSON body', async () => {
    enable(); const result = await POST(request(site, JSON.stringify({ accountId: 'other', wabaId: '123', partnerCustomerId: 'chosen' })));
    expect(result.status).toBe(400); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('ignores browser query selectors and uses auth actor with configured namespace', async () => {
    const database = enable(); const result = await POST(request());
    expect(result.status).toBe(200); expect(mocks.auth).toHaveBeenCalledWith('admin');
    expect(database.rpc).toHaveBeenCalledExactlyOnceWith('reserve_ycloud_onboarding', { p_account_id: context.accountId, p_actor_id: context.userId, p_endpoint_namespace: 'endpoint-a' });
    expect(result.headers.get('cache-control')).toBe('no-store'); expect(await result.json()).toMatchObject({ operational: false, coexistenceVerified: false });
  });
  it('GET does not require Origin and still scopes its status RPC', async () => {
    const database = enable(); const result = await GET(); expect(result.status).toBe(200);
    expect(database.rpc).toHaveBeenCalledExactlyOnceWith('get_ycloud_onboarding_status', { p_account_id: context.accountId, p_actor_id: context.userId, p_endpoint_namespace: 'endpoint-a' });
  });
  it('reconcile POST invokes only the authenticated reconciliation RPC', async () => {
    const database = enable(); const result = await reconcilePOST(request()); expect(result.status).toBe(200);
    expect(database.rpc.mock.calls[0][0]).toBe('reconcile_ycloud_onboarding');
  });
  it.each([new UnauthorizedError(), new ForbiddenError()])('rejects failed session/role guard before database', async (error) => {
    enable(); mocks.auth.mockRejectedValue(error); const result = await POST(request()); expect(result.status).toBe(error.status); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('disabled flag returns 404 before origin or database handling', async () => {
    enable(); vi.stubEnv('YCLOUD_CUSTOMER_LINK_ENABLED', 'false'); const result = await POST(request(null)); expect(result.status).toBe(404); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('current database membership failure overrides an authenticated HTTP session', async () => {
    enable(); mocks.admin.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'YC403', message: 'private' } }) });
    const result = await POST(request()); expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: 'onboarding_forbidden' });
  });
  it('database throws return generic 503 without private content', async () => {
    enable(); mocks.admin.mockImplementation(() => { throw new Error('private-secret'); });
    const result = await POST(request()); expect(result.status).toBe(503); expect(result.headers.get('cache-control')).toBe('no-store'); expect(await result.json()).toEqual({ error: 'onboarding_storage_failed' });
  });
});
