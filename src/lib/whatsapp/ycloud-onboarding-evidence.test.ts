import { createHash, createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { acceptYCloudOnboardingEvidence } from './ycloud-onboarding-evidence';

const config = {
  enabled: true,
  endpointNamespace: 'pilot-endpoint',
  webhookSecret: 'synthetic-webhook-secret',
};
const body = {
  id: 'event-1',
  apiVersion: 'v2',
  type: 'whatsapp.business_account.updated',
  whatsappBusinessAccount: {
    id: '1234',
    updateEvent: 'PARTNER_ADDED',
    partnerCustomerId: 'customer-opaque',
    paymentMethodAttached: false,
  },
};
function request(
  raw = JSON.stringify(body),
  timestamp = Math.floor(Date.now() / 1000)
) {
  const signature = createHmac('sha256', config.webhookSecret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return new Request('https://crm.test/api/whatsapp/ycloud/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'ycloud-signature': `t=${timestamp},s=${signature}` },
  });
}
function database(result: unknown = { inserted: true }, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data: result, error }));
  const factory = vi.fn(() => ({ rpc }) as unknown as SupabaseClient);
  return { rpc, factory };
}
describe('YCloud onboarding evidence acceptance', () => {
  it('does not read or initialize DB when disabled', async () => {
    const { factory } = database();
    await expect(
      acceptYCloudOnboardingEvidence(
        request(),
        { ...config, enabled: false },
        factory
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['', 'bad/namespace', 'x'.repeat(101)])(
    'rejects invalid server namespace %s',
    async (endpointNamespace) => {
      const { factory } = database();
      await expect(
        acceptYCloudOnboardingEvidence(
          request(),
          { ...config, endpointNamespace },
          factory
        )
      ).rejects.toMatchObject({ status: 503 });
      expect(factory).not.toHaveBeenCalled();
    }
  );
  it('stores only the minimum evidence and exact digest', async () => {
    const { factory, rpc } = database();
    const raw = JSON.stringify({
      ...body,
      secretExtra: 'must-not-be-stored',
      accountId: 'not-authority',
    });
    await expect(
      acceptYCloudOnboardingEvidence(request(raw), config, factory)
    ).resolves.toEqual({
      received: true,
      duplicate: false,
      operational: false,
    });
    expect(rpc).toHaveBeenCalledWith('record_ycloud_onboarding_evidence', {
      p_endpoint_namespace: 'pilot-endpoint',
      p_event_id: 'event-1',
      p_waba_id: '1234',
      p_partner_customer_id: 'customer-opaque',
      p_payment_method_attached: false,
      p_payload_digest: createHash('sha256').update(raw).digest('hex'),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('must-not-be-stored');
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('not-authority');
  });
  it('awaits durable commit before returning success', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const factory = () => ({ rpc: () => pending }) as unknown as SupabaseClient;
    let returned = false;
    const accepted = acceptYCloudOnboardingEvidence(
      request(),
      config,
      factory
    ).then(() => {
      returned = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(returned).toBe(false);
    resolve({ data: { inserted: true }, error: null });
    await accepted;
    expect(returned).toBe(true);
  });
  it('recognizes a durable duplicate without enabling a connection', async () => {
    await expect(
      acceptYCloudOnboardingEvidence(
        request(),
        config,
        database({ inserted: false }).factory
      )
    ).resolves.toEqual({ received: true, duplicate: true, operational: false });
  });
  it('rejects a signature before interpreting JSON or touching storage', async () => {
    const { factory } = database();
    const req = request('{not-json');
    req.headers.set('ycloud-signature', 'invalid');
    await expect(
      acceptYCloudOnboardingEvidence(req, config, factory)
    ).rejects.toMatchObject({ status: 401 });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, type: 'whatsapp.inbound_message.received' },
    {
      ...body,
      whatsappBusinessAccount: {
        ...body.whatsappBusinessAccount,
        updateEvent: 'OTHER',
      },
    },
  ])('never acknowledges unsupported events', async (payload) => {
    const { factory } = database();
    await expect(
      acceptYCloudOnboardingEvidence(
        request(JSON.stringify(payload)),
        config,
        factory
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([null, { inserted: 1 }, {}])(
    'refuses ambiguous storage success %s',
    async (result) => {
      await expect(
        acceptYCloudOnboardingEvidence(
          request(),
          config,
          database(result).factory
        )
      ).rejects.toMatchObject({ status: 503 });
    }
  );
  it('classifies immutable identity conflicts without reflecting provider or DB content', async () => {
    await expect(
      acceptYCloudOnboardingEvidence(
        request(),
        config,
        database(null, { code: 'YC409', message: 'private' }).factory
      )
    ).rejects.toMatchObject({
      status: 409,
      message: 'evidence_identity_conflict',
    });
  });
  it('makes database failure retryable without success ACK', async () => {
    await expect(
      acceptYCloudOnboardingEvidence(
        request(),
        config,
        database(null, { code: 'OTHER', message: 'private' }).factory
      )
    ).rejects.toMatchObject({
      status: 503,
      message: 'durable_acceptance_failed',
    });
  });
});
