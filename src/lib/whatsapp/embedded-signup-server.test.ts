import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateSignup,
  exchangeSignupCode,
  getSignupConfig,
  SignupError,
  verifySignupAssets,
} from './embedded-signup-server';

const config = {
  appId: '111',
  appSecret: 'app-secret',
  configId: '222',
  version: 'v25.0',
  verifyToken: 'verify-secret',
};
const input = {
  code: 'auth-code',
  state: 'a'.repeat(64),
  pin: '012345',
  wabaId: '123',
  phoneNumberId: '456',
};
const authorized = {
  data: {
    app_id: '111',
    is_valid: true,
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    granular_scopes: [
      { scope: 'whatsapp_business_management', target_ids: ['123'] },
    ],
  },
};
const fetchMock = vi.fn();
const ok = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Meta onboarding configuration', () => {
  it('stays disabled unless explicitly configured', () => {
    vi.stubEnv('META_EMBEDDED_SIGNUP_ENABLED', 'false');
    expect(getSignupConfig()).toBeNull();
  });
  it('requires version, encryption and webhook setup, without exposing secrets', () => {
    vi.stubEnv('META_EMBEDDED_SIGNUP_ENABLED', 'true');
    vi.stubEnv('META_APP_ID', '111');
    vi.stubEnv('META_APP_SECRET', 'secret');
    vi.stubEnv('META_EMBEDDED_SIGNUP_CONFIG_ID', '222');
    vi.stubEnv('META_EMBEDDED_SIGNUP_API_VERSION', 'v25.0');
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'webhook-secret');
    expect(getSignupConfig()?.configId).toBe('222');
    vi.stubEnv('META_EMBEDDED_SIGNUP_API_VERSION', '../');
    expect(getSignupConfig()).toBeNull();
  });
});
describe('Meta onboarding HTTP', () => {
  it('exchanges code via POST body, with timeout and no caching', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'customer-token' }));
    expect(await exchangeSignupCode(config, input.code)).toBe('customer-token');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain(input.code);
    expect(url).not.toContain(config.appSecret);
    expect(init.body.get('code')).toBe(input.code);
    expect(init.body.get('client_secret')).toBe(config.appSecret);
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('redacts Meta errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'LEAK-secret' } }), {
        status: 400,
      })
    );
    await expect(exchangeSignupCode(config, input.code)).rejects.not.toThrow(
      'LEAK-secret'
    );
  });
  it('rejects a missing token', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(exchangeSignupCode(config, input.code)).rejects.toBeInstanceOf(
      SignupError
    );
  });
  it('rejects network failures safely', async () => {
    fetchMock.mockRejectedValue(new Error('secret network URL'));
    await expect(exchangeSignupCode(config, input.code)).rejects.toThrow(
      'A Meta não respondeu'
    );
  });
  it.each([
    { app_id: 'other-app' },
    { is_valid: false },
    { expires_at: 1 },
    { scopes: [] },
    { granular_scopes: [] },
  ])('rejects an invalid grant %j', async (patch) => {
    fetchMock.mockResolvedValue(ok({ data: { ...authorized.data, ...patch } }));
    await expect(verifySignupAssets(config, 'token', input)).rejects.toThrow(
      'não permite'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('verifies phone membership, using a fixed host for pagination', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(authorized))
      .mockResolvedValueOnce(
        ok({
          data: [],
          paging: { next: 'https://evil.test', cursors: { after: 'cursor' } },
        })
      )
      .mockResolvedValueOnce(
        ok({ data: [{ id: '456', display_phone_number: '+5511999999999' }] })
      );
    expect((await verifySignupAssets(config, 'token', input)).id).toBe('456');
    expect(fetchMock.mock.calls[2][0]).toContain(
      'https://graph.facebook.com/v25.0/123/phone_numbers?'
    );
    expect(fetchMock.mock.calls[2][0]).toContain('after=cursor');
  });
  it('rejects a number from another WABA', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(authorized))
      .mockResolvedValueOnce(ok({ data: [{ id: '999' }] }));
    await expect(verifySignupAssets(config, 'token', input)).rejects.toThrow(
      'não pertence'
    );
  });
  it('registers and subscribes, requiring affirmative success for both', async () => {
    fetchMock.mockImplementation(async () => ok({ success: true }));
    await activateSignup(config, 'token', input);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://graph.facebook.com/v25.0/456/register',
      'https://graph.facebook.com/v25.0/123/subscribed_apps',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).pin).toBe('012345');
  });
  it('does not subscribe when registration is unconfirmed', async () => {
    fetchMock.mockResolvedValue(ok({ success: false }));
    await expect(activateSignup(config, 'token', input)).rejects.toThrow(
      'registro'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
