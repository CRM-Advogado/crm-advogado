import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  admin: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  encrypt: vi.fn(),
  exchange: vi.fn(),
  verify: vi.fn(),
  activate: vi.fn(),
  config: vi.fn(),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: mocks.encrypt }));
vi.mock('@/lib/whatsapp/embedded-signup-server', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/whatsapp/embedded-signup-server')
  >()),
  getSignupConfig: mocks.config,
  exchangeSignupCode: mocks.exchange,
  verifySignupAssets: mocks.verify,
  activateSignup: mocks.activate,
}));
import { GET, POST, PUT } from './route';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
const input = {
  state: 'a'.repeat(64),
  code: 'SECRET-CODE',
  pin: '123456',
  wabaId: '123',
  phoneNumberId: '456',
  accountId: 'attacker-account',
};
let chain: Record<string, ReturnType<typeof vi.fn>>;
function request(
  method: string,
  body: unknown = input,
  options: { origin?: string; cookie?: string } = {}
) {
  return new NextRequest('https://crm.test/api/whatsapp/embedded-signup', {
    method,
    headers: {
      origin: options.origin ?? 'https://crm.test',
      'content-type': 'application/json',
      cookie: `whatsapp_signup_state=${options.cookie ?? input.state}`,
    },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  chain = Object.fromEntries(
    ['update', 'select', 'eq', 'gt', 'maybeSingle'].map((name) => [
      name,
      vi.fn(),
    ])
  );
  for (const fn of Object.values(chain)) fn.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue({
    data: { id: 'session-id' },
    error: null,
  });
  mocks.from.mockReturnValue(chain);
  mocks.rpc.mockResolvedValue({ data: 'session-id', error: null });
  mocks.admin.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
  mocks.requireRole.mockResolvedValue({
    accountId: 'office-A',
    userId: 'admin-A',
    supabase: { from: mocks.from },
  });
  mocks.config.mockReturnValue({
    appId: '111',
    configId: '222',
    appSecret: 'APP-SECRET',
    version: 'v25.0',
    verifyToken: 'VERIFY-SECRET',
  });
  mocks.encrypt.mockImplementation((value: string) => `encrypted:${value}`);
  mocks.exchange.mockResolvedValue('ACCESS-SECRET');
  mocks.verify.mockResolvedValue({
    id: '456',
    display_phone_number: '+551100000000',
  });
  mocks.activate.mockResolvedValue(undefined);
});
describe('Embedded Signup authorization and readiness', () => {
  it.each([new UnauthorizedError(), new ForbiddenError()])(
    'denies unauthenticated/non-admin callers',
    async (error) => {
      mocks.requireRole.mockRejectedValue(error);
      expect((await POST(request('POST'))).status).toBe(error.status);
      expect(mocks.admin).not.toHaveBeenCalled();
    }
  );
  it('rejects cross-origin requests before auth or any mutation', async () => {
    expect(
      (await POST(request('POST', null, { origin: 'https://evil.test' })))
        .status
    ).toBe(403);
    expect(mocks.requireRole).not.toHaveBeenCalled();
  });
  it('returns only public SDK configuration', async () => {
    const response = await GET();
    const text = await response.text();
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(text).toContain('222');
    expect(text).not.toContain('SECRET');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'office-A');
  });
  it('starts a hashed persistent session with a secure cookie', async () => {
    const response = await POST(request('POST'));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.state).toMatch(/^[a-f0-9]{64}$/);
    const params = mocks.rpc.mock.calls[0][1];
    expect(params.p_account).toBe('office-A');
    expect(params.p_user).toBe('admin-A');
    expect(params.p_hash).not.toBe(payload.state);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('SameSite=strict');
  });
  it('fails closed when setup is incomplete', async () => {
    mocks.config.mockReturnValue(null);
    expect((await POST(request('POST'))).status).toBe(503);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(['signup_busy', 'signup_already_connected'])(
    'maps %s to a clear conflict',
    async (message) => {
      mocks.rpc.mockResolvedValue({ error: { message } });
      expect((await POST(request('POST'))).status).toBe(409);
    }
  );
});
describe('Embedded Signup completion integration', () => {
  it('encrypts the token, commits only after activation and never trusts accountId from the body', async () => {
    const response = await PUT(request('PUT'));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('SECRET');
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'office-A');
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'admin-A');
    expect(chain.eq).toHaveBeenCalledWith('status', 'pending');
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      'reserve_whatsapp_signup',
      expect.objectContaining({
        p_account: 'office-A',
        p_user: 'admin-A',
        p_waba: '123',
      })
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      'finish_whatsapp_signup',
      expect.objectContaining({
        p_token: 'encrypted:ACCESS-SECRET',
        p_verify: 'encrypted:VERIFY-SECRET',
        p_account: 'office-A',
      })
    );
    expect(mocks.encrypt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activate.mock.invocationCallOrder[0]
    );
    expect(mocks.activate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[1]
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('denies a state that does not match the HttpOnly cookie', async () => {
    expect(
      (await PUT(request('PUT', input, { cookie: 'b'.repeat(64) }))).status
    ).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('denies replay, expiration and another user/account before contacting Meta', async () => {
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await PUT(request('PUT'))).status).toBe(409);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('rejects bad input before the database', async () => {
    expect((await PUT(request('PUT', { ...input, pin: 'bad' }))).status).toBe(
      400
    );
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('does not register a conflicting WABA/number', async () => {
    mocks.rpc.mockResolvedValue({ error: { code: '23505' } });
    expect((await PUT(request('PUT'))).status).toBe(409);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith({ status: 'failed' });
  });
  it('does not activate or save an unauthorized asset', async () => {
    mocks.verify.mockRejectedValue(new Error('SENSITIVE-META-ERROR'));
    const response = await PUT(request('PUT'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('SENSITIVE');
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not activate if encryption fails', async () => {
    mocks.encrypt.mockImplementation(() => {
      throw new Error('key error');
    });
    expect((await PUT(request('PUT'))).status).toBe(500);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it('never marks the account connected if registration/subscription fails', async () => {
    mocks.activate.mockRejectedValue(new Error('Meta refused'));
    expect((await PUT(request('PUT'))).status).toBe(500);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('explains partial success if the final DB transaction fails', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'SENSITIVE-DB' } });
    const response = await PUT(request('PUT'));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('suporte antes de repetir');
  });
});
