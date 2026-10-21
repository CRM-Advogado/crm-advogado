import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightYCloudOwnAccount } from './providers/ycloud-preflight';
const auth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/account', () => ({
  requireRole: auth,
  toErrorResponse: (error: { status?: number }) =>
    Response.json({ error: 'denied' }, { status: error.status ?? 500 }),
}));
import { GET } from '@/app/api/whatsapp/ycloud/preflight/route';
const config = {
  enabled: true,
  accountId: 'account-a',
  apiKey: 'FAKE_PRIVATE_KEY',
  wabaId: '123456',
  phoneNumber: '+5511999999999',
};
const resources = () => [
  new Response(JSON.stringify({ id: config.wabaId })),
  new Response(
    JSON.stringify({
      id: '98765',
      wabaId: config.wabaId,
      phoneNumber: config.phoneNumber,
      status: 'CONNECTED',
      codeVerificationStatus: 'VERIFIED',
    })
  ),
];
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue({ accountId: 'account-a' });
  vi.stubEnv('YCLOUD_OWN_ACCOUNT_PREFLIGHT_ENABLED', 'true');
  vi.stubEnv('YCLOUD_OWN_ACCOUNT_ID', config.accountId);
  vi.stubEnv('YCLOUD_API_KEY', config.apiKey);
  vi.stubEnv('YCLOUD_OWN_WABA_ID', config.wabaId);
  vi.stubEnv('YCLOUD_OWN_PHONE_NUMBER', config.phoneNumber);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('independent YCloud own-account preflight QA', () => {
  it('only reads fixed encoded resources and never reports operational connectivity', async () => {
    const [waba, phone] = resources();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(waba)
      .mockResolvedValueOnce(phone);
    vi.stubGlobal('fetch', fetchMock);
    const result = await preflightYCloudOwnAccount('account-a', config);
    expect(result).toEqual({
      status: 'resource_verified',
      resourcesVerified: true,
      coexistenceVerified: false,
      customerBindingVerified: false,
      operational: false,
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.ycloud.com/v2/whatsapp/businessAccounts/123456',
      'https://api.ycloud.com/v2/whatsapp/phoneNumbers/123456/%2B5511999999999',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'X-API-Key': config.apiKey },
      });
      expect(init.body).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    expect(result).not.toHaveProperty('connected');
  });
  it.each([{ enabled: false }, { accountId: 'other' }])(
    'rejects disabled or unallowlisted access before HTTP %j',
    async (change) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        preflightYCloudOwnAccount('account-a', { ...config, ...change })
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it.each([
    { wabaId: '123/../../internal' },
    { phoneNumber: 'https://internal.invalid' },
    { apiKey: '' },
  ])('rejects invalid server selectors before HTTP %j', async (change) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      preflightYCloudOwnAccount('account-a', { ...config, ...change })
    ).rejects.toMatchObject({ code: 'server_configuration_incomplete' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])(
    'never echoes a provider error or key for HTTP %s',
    async (status) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ error: { message: config.apiKey } }),
              { status }
            )
          )
      );
      const error = await preflightYCloudOwnAccount('account-a', config).catch(
        (e) => e
      );
      expect(error.message).not.toContain(config.apiKey);
      expect(JSON.stringify(log.mock.calls)).not.toContain(config.apiKey);
    }
  );
  it('reports missing authorization for unavailable resources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    );
    expect(await preflightYCloudOwnAccount('account-a', config)).toMatchObject({
      status: 'awaiting_authorization',
      resourcesVerified: false,
      operational: false,
    });
  });
  it.each([
    { id: 'different' },
    {
      id: config.wabaId,
      phone: { id: '98765', wabaId: 'other', phoneNumber: config.phoneNumber },
    },
    {
      id: config.wabaId,
      phone: {
        id: '98765',
        wabaId: config.wabaId,
        phoneNumber: '+15551234567',
      },
    },
  ])('rejects provider resource mismatch %j', async (data) => {
    const responses = resources();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: data.id })))
        .mockResolvedValueOnce(
          'phone' in data
            ? new Response(JSON.stringify(data.phone))
            : responses[1]
        )
    );
    await expect(
      preflightYCloudOwnAccount('account-a', config)
    ).rejects.toMatchObject({ code: 'resource_mismatch' });
  });
  it('bounds provider response size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(65537)))
    );
    await expect(
      preflightYCloudOwnAccount('account-a', config)
    ).rejects.toMatchObject({ code: 'invalid_provider_response' });
  });
});
describe('independent preflight route authorization QA', () => {
  it('requires admin role before any HTTP work', async () => {
    auth.mockRejectedValue({ status: 403 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET()).status).toBe(403);
    expect(auth).toHaveBeenCalledWith('admin');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not enumerate resources to another authenticated account', async () => {
    auth.mockResolvedValue({ accountId: 'other' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(config.wabaId);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ignores forged request account and selectors and never caches diagnostic output', async () => {
    const [a, b] = resources();
    const fetchMock = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    vi.stubGlobal('fetch', fetchMock);
    const response = await (
      GET as unknown as (request: Request) => Promise<Response>
    )(
      new Request(
        'https://crm.invalid/api/whatsapp/ycloud/preflight?accountId=other&wabaId=attacker&apiKey=forged'
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock.mock.calls[0][0]).toContain(config.wabaId);
    expect(fetchMock.mock.calls[0][1].headers['X-API-Key']).toBe(config.apiKey);
    expect(await response.text()).not.toContain(config.apiKey);
  });
});

it.each([
  { status: 'PENDING', codeVerificationStatus: 'VERIFIED' },
  { status: 'DISCONNECTED', codeVerificationStatus: 'VERIFIED' },
  { status: 'CONNECTED', codeVerificationStatus: 'NOT_VERIFIED' },
  {},
])(
  'does not report verified resources for pending or unverified phone state %j',
  async (state) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: config.wabaId }))
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: '98765',
            wabaId: config.wabaId,
            phoneNumber: config.phoneNumber,
            ...state,
          })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await preflightYCloudOwnAccount('account-a', config)).toMatchObject({
      status: 'awaiting_authorization',
      operational: false,
      coexistenceVerified: false,
      customerBindingVerified: false,
    });
  }
);
