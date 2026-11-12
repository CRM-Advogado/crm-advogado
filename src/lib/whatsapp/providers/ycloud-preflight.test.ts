import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  preflightYCloudOwnAccount,
  type YCloudPreflightConfig,
} from './ycloud-preflight';

const config: YCloudPreflightConfig = {
  enabled: true,
  accountId: 'own-account',
  apiKey: 'PRIVATE_TEST_ONLY',
  wabaId: '12345',
  phoneNumber: '+5511999999999',
};
afterEach(() => vi.unstubAllGlobals());

function responses(...bodies: unknown[]) {
  const mock = vi.fn();
  for (const body of bodies) mock.mockResolvedValueOnce(Response.json(body));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('YCloud own-account preflight', () => {
  it('only reads exact server-selected resources and does not claim operational readiness', async () => {
    const fetch = responses(
      { id: '12345' },
      {
        id: '67890',
        wabaId: '12345',
        phoneNumber: config.phoneNumber,
        status: 'CONNECTED',
        codeVerificationStatus: 'VERIFIED',
        partnerCustomerId: 'untrusted-extra',
        coexistence: true,
      }
    );
    const result = await preflightYCloudOwnAccount(config.accountId, config);
    expect(result).toEqual({
      status: 'resource_verified',
      resourcesVerified: true,
      coexistenceVerified: false,
      customerBindingVerified: false,
      operational: false,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.ycloud.com/v2/whatsapp/businessAccounts/12345',
      'https://api.ycloud.com/v2/whatsapp/phoneNumbers/12345/%2B5511999999999',
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'X-API-Key': config.apiKey },
      });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });
  it.each(['PENDING', 'DISCONNECTED', 'UNKNOWN', undefined])(
    'keeps an inactive number awaiting authorization (%s)',
    async (status) => {
      responses(
        { id: '12345' },
        {
          id: '67890',
          wabaId: '12345',
          phoneNumber: config.phoneNumber,
          status,
          codeVerificationStatus: 'VERIFIED',
        }
      );
      expect(
        await preflightYCloudOwnAccount(config.accountId, config)
      ).toMatchObject({
        status: 'awaiting_authorization',
        resourcesVerified: true,
        operational: false,
      });
    }
  );
  it('requires explicit verified code status even when CONNECTED', async () => {
    responses(
      { id: '12345' },
      {
        id: '67890',
        wabaId: '12345',
        phoneNumber: config.phoneNumber,
        status: 'CONNECTED',
      }
    );
    expect(
      await preflightYCloudOwnAccount(config.accountId, config)
    ).toMatchObject({ status: 'awaiting_authorization' });
  });
  it.each([
    [{ ...config, enabled: false }, 'own-account', 'disabled'],
    [config, 'other-account', 'account_not_allowed'],
    [{ ...config, accountId: '' }, 'own-account', 'account_not_allowed'],
    [
      { ...config, apiKey: '' },
      'own-account',
      'server_configuration_incomplete',
    ],
    [
      { ...config, wabaId: '../untrusted' },
      'own-account',
      'server_configuration_incomplete',
    ],
    [
      { ...config, phoneNumber: '5511999999999' },
      'own-account',
      'server_configuration_incomplete',
    ],
  ])(
    'rejects invalid access/config before network',
    async (snapshot, accountId, code) => {
      const fetch = responses();
      await expect(
        preflightYCloudOwnAccount(accountId, snapshot)
      ).rejects.toMatchObject({ code });
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it('reports missing resource without trying to register anything', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await preflightYCloudOwnAccount(config.accountId, config)
    ).toMatchObject({
      status: 'awaiting_authorization',
      operational: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ id: 'wrong' }],
    [
      { id: '12345' },
      { id: '67890', wabaId: 'wrong', phoneNumber: config.phoneNumber },
    ],
    [
      { id: '12345' },
      { id: '67890', wabaId: '12345', phoneNumber: '+5511888888888' },
    ],
  ])('rejects mismatched provider resources', async (...bodies) => {
    responses(...bodies);
    await expect(
      preflightYCloudOwnAccount(config.accountId, config)
    ).rejects.toMatchObject({ code: 'resource_mismatch' });
  });
  it('does not reflect malformed JSON or upstream descriptions in errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`{"secret":"${config.apiKey}`))
    );
    await expect(
      preflightYCloudOwnAccount(config.accountId, config)
    ).rejects.toThrow('invalid_provider_response');
  });
  it('does not retry provider failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(config.apiKey));
    vi.stubGlobal('fetch', fetch);
    await expect(
      preflightYCloudOwnAccount(config.accountId, config)
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
