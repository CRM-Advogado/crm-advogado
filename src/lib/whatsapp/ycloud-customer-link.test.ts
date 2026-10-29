import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  assertYCloudMutationOrigin,
  runYCloudCustomerLink,
} from './ycloud-customer-link';

const context = { accountId: 'account-a', userId: 'actor-a' };
const config = { enabled: true, endpointNamespace: 'endpoint-a' };
const safe = {
  status: 'reserved',
  sessionId: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2026-10-28T14:00:00+00:00',
  operational: false,
  coexistenceVerified: false,
};
function database(data: unknown = safe, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  const factory = vi.fn(() => ({ rpc }) as unknown as SupabaseClient);
  return { factory, rpc };
}
describe('own-account YCloud first-cycle reservations', () => {
  it.each(['reserve', 'reconcile', 'status'] as const)(
    'uses server context for %s',
    async (operation) => {
      const { factory, rpc } = database();
      const result = await runYCloudCustomerLink(
        operation,
        context,
        config,
        factory
      );
      expect(rpc).toHaveBeenCalledWith(
        {
          reserve: 'reserve_ycloud_onboarding',
          reconcile: 'reconcile_ycloud_onboarding',
          status: 'get_ycloud_onboarding_status',
        }[operation],
        {
          p_account_id: 'account-a',
          p_actor_id: 'actor-a',
          p_endpoint_namespace: 'endpoint-a',
        }
      );
      expect(result).toEqual({
        ...safe,
        expiresAt: '2026-10-28T14:00:00.000Z',
      });
    }
  );
  it('does not initialize storage when disabled', async () => {
    const { factory } = database();
    await expect(
      runYCloudCustomerLink(
        'reserve',
        context,
        { ...config, enabled: false },
        factory
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(factory).not.toHaveBeenCalled();
  });
  it('strips private identifiers even if storage unexpectedly includes them', async () => {
    const { factory } = database({
      ...safe,
      partner_customer_id: 'private',
      waba_id: '123',
      endpoint_namespace: 'private',
      account_id: 'private',
      evidence_event_id: 'private',
    });
    expect(
      JSON.stringify(
        await runYCloudCustomerLink('status', context, config, factory)
      )
    ).not.toContain('private');
  });
  it.each(['', 'bad/namespace'])(
    'fails closed for invalid namespace %s',
    async (endpointNamespace) => {
      const { factory } = database();
      await expect(
        runYCloudCustomerLink(
          'reserve',
          context,
          { ...config, endpointNamespace },
          factory
        )
      ).rejects.toMatchObject({ status: 503 });
      expect(factory).not.toHaveBeenCalled();
    }
  );
  it.each([
    { ...safe, operational: true },
    { ...safe, coexistenceVerified: true },
    { ...safe, status: 'connected' },
    { ...safe, sessionId: 'arbitrary' },
    { ...safe, expiresAt: 'invalid' },
    null,
  ])('never passes malformed or operational storage status', async (data) => {
    await expect(
      runYCloudCustomerLink('status', context, config, database(data).factory)
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    ['YC403', 403],
    ['YC409', 409],
    ['XX000', 503],
  ] as const)('sanitizes storage error %s', async (code, status) => {
    const pending = runYCloudCustomerLink(
      'reserve',
      context,
      config,
      database(null, { code, message: 'private database details' }).factory
    );
    await expect(pending).rejects.toMatchObject({ status });
    await expect(pending).rejects.not.toMatchObject({
      message: 'private database details',
    });
  });
  it('returns a safe not-started status without optional IDs', async () => {
    const result = await runYCloudCustomerLink(
      'status',
      context,
      config,
      database({
        status: 'not_started',
        operational: false,
        coexistenceVerified: false,
        partnerCustomerId: 'private',
      }).factory
    );
    expect(result).toEqual({
      status: 'not_started',
      operational: false,
      coexistenceVerified: false,
    });
  });
});

describe('YCloud cookie mutation origin boundary', () => {
  function mutation(
    origin: string | null = 'https://crm.example',
    extra: Record<string, string> = {},
    body?: string
  ) {
    return new Request('https://untrusted-host.example/path', {
      method: 'POST',
      headers: { ...(origin === null ? {} : { origin }), ...extra },
      body,
    });
  }
  it('uses canonical configured site rather than Host-derived request origin', () => {
    expect(() =>
      assertYCloudMutationOrigin(mutation(), 'https://crm.example')
    ).not.toThrow();
    expect(() =>
      assertYCloudMutationOrigin(
        mutation('https://untrusted-host.example'),
        'https://crm.example'
      )
    ).toThrow('invalid_request_origin');
  });
  it.each([null, 'null', 'https://evil.example', 'https://crm.example.evil'])(
    'rejects Origin %s',
    (origin) => {
      expect(() =>
        assertYCloudMutationOrigin(mutation(origin), 'https://crm.example')
      ).toThrow('invalid_request_origin');
    }
  );
  it('rejects a cross-site fetch despite forged matching Origin', () => {
    expect(() =>
      assertYCloudMutationOrigin(
        mutation(undefined, { 'sec-fetch-site': 'cross-site' }),
        'https://crm.example'
      )
    ).toThrow('invalid_request_origin');
  });
  it.each([
    '',
    'http://crm.example',
    'https://user:password@crm.example',
    'https://crm.example/path',
    'https://crm.example/?x=1',
  ])('rejects invalid canonical URL %s', (site) => {
    expect(() => assertYCloudMutationOrigin(mutation(), site)).toThrow(
      'server_configuration_incomplete'
    );
  });
  it('allows explicit localhost development origin', () => {
    expect(() =>
      assertYCloudMutationOrigin(
        mutation('http://localhost:3000'),
        'http://localhost:3000'
      )
    ).not.toThrow();
  });
  it('does not accept browser-selected mutation fields', () => {
    expect(() =>
      assertYCloudMutationOrigin(
        mutation(undefined, {}, '{"accountId":"other"}'),
        'https://crm.example'
      )
    ).toThrow('request_body_not_allowed');
  });
});
