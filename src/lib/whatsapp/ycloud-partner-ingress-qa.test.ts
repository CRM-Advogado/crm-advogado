import { createHash, createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptYCloudOnboardingEvidence } from './ycloud-onboarding-evidence';
import { POST } from '@/app/api/whatsapp/ycloud/webhook/route';

const adminMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: adminMock }));

const secret = 'independent-synthetic-endpoint-secret';
const config = { enabled: true, endpointNamespace: 'endpoint-a', webhookSecret: secret };
const envelope = () => ({
  id: 'event-independent', apiVersion: 'v2', type: 'whatsapp.business_account.updated',
  whatsappBusinessAccount: { id: '123456', updateEvent: 'PARTNER_ADDED', partnerCustomerId: 'opaque-customer-a', paymentMethodAttached: true },
});
function request(body: string | Uint8Array = JSON.stringify(envelope()), age = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000) + age);
  const signature = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
  return new Request('https://crm.invalid/api/whatsapp/ycloud/webhook?account_id=forged', {
    method: 'POST', body: body as BodyInit,
    headers: { 'ycloud-signature': `t=${timestamp},s=${signature}` },
  });
}
function database(result: unknown = { inserted: true }, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: result, error });
  const factory = vi.fn(() => ({ rpc }) as unknown as SupabaseClient);
  return { rpc, factory };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); adminMock.mockReset(); });
describe('independent YCloud onboarding evidence QA', () => {
  it('does not initialize a database when disabled', async () => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request(), { ...config, enabled: false }, db.factory)).rejects.toMatchObject({ status: 404 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it.each(['', 'endpoint/escape', ' '.repeat(5)])('rejects namespace %j before persistence', async (endpointNamespace) => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request(), { ...config, endpointNamespace }, db.factory)).rejects.toMatchObject({ status: 503 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('persists only minimal evidence and raw digest, never client-selected account or signature', async () => {
    const db = database();
    const body = JSON.stringify({ ...envelope(), account_id: 'forged', message: { text: 'DO_NOT_STORE' } });
    expect(await acceptYCloudOnboardingEvidence(request(body), config, db.factory)).toEqual({ received: true, duplicate: false, operational: false });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('record_ycloud_onboarding_evidence', {
      p_endpoint_namespace: 'endpoint-a', p_event_id: 'event-independent', p_waba_id: '123456',
      p_partner_customer_id: 'opaque-customer-a', p_payment_method_attached: true,
      p_payload_digest: createHash('sha256').update(body).digest('hex'),
    });
    expect(JSON.stringify(db.rpc.mock.calls)).not.toMatch(/DO_NOT_STORE|forged|independent-synthetic-endpoint-secret/);
  });
  it('reports an identical replay without creating an operational connection', async () => {
    const db = database({ inserted: false });
    expect(await acceptYCloudOnboardingEvidence(request(), config, db.factory)).toEqual({ received: true, duplicate: true, operational: false });
  });
  it('awaits persistence completion before reporting success', async () => {
    let resolve!: (value: unknown) => void;
    const db = database();
    db.rpc.mockImplementation(() => new Promise((done) => { resolve = done; }));
    let completed = false;
    const pending = acceptYCloudOnboardingEvidence(request(), config, db.factory).then(() => { completed = true; });
    await vi.waitFor(() => expect(db.rpc).toHaveBeenCalled());
    expect(completed).toBe(false);
    resolve({ data: { inserted: true }, error: null });
    await pending;
    expect(completed).toBe(true);
  });
  it('maps immutable identity conflict to 409', async () => {
    const db = database(null, { code: 'YC409', message: 'private-provider-body' });
    await expect(acceptYCloudOnboardingEvidence(request(), config, db.factory)).rejects.toMatchObject({ status: 409, code: 'evidence_identity_conflict' });
  });
  it.each([null, {}, { inserted: 'true' }])('refuses malformed durable acceptance %j', async (response) => {
    const db = database(response);
    await expect(acceptYCloudOnboardingEvidence(request(), config, db.factory)).rejects.toMatchObject({ status: 503 });
  });
  it('refuses database errors without reflecting their content', async () => {
    const db = database(null, { code: 'DBFAIL', message: secret });
    await expect(acceptYCloudOnboardingEvidence(request(), config, db.factory)).rejects.toMatchObject({ status: 503, message: 'durable_acceptance_failed' });
  });
  it.each([-301, 301])('rejects signed requests outside replay window %i', async (age) => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request(undefined, age), config, db.factory)).rejects.toMatchObject({ status: 401 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('rejects tampered bytes before parsing or persistence', async () => {
    const db = database();
    const signed = request();
    const changed = new Request(signed.url, { method: 'POST', headers: signed.headers, body: JSON.stringify(envelope()) + ' ' });
    await expect(acceptYCloudOnboardingEvidence(changed, config, db.factory)).rejects.toMatchObject({ status: 401 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('rejects malformed UTF8 before persistence', async () => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request(new Uint8Array([0xc3, 0x28])), config, db.factory)).rejects.toMatchObject({ status: 400 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('bounds a body without content-length', async () => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request('x'.repeat(1_048_577)), config, db.factory)).rejects.toMatchObject({ status: 413 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it.each(['whatsapp.inbound_message.received', 'whatsapp.smb.message.echoes', 'whatsapp.message.updated'])('does not ACK unsupported family %s', async (type) => {
    const db = database();
    await expect(acceptYCloudOnboardingEvidence(request(JSON.stringify({ ...envelope(), type })), config, db.factory)).rejects.toMatchObject({ status: 422 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('does not ACK an unsupported WABA update', async () => {
    const db = database(); const body = envelope(); body.whatsappBusinessAccount.updateEvent = 'PARTNER_REMOVED';
    await expect(acceptYCloudOnboardingEvidence(request(JSON.stringify(body)), config, db.factory)).rejects.toMatchObject({ status: 422 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it.each(['', ' x', 'x\n', 'x'.repeat(257)])('rejects unsafe customer identifier %j', async (id) => {
    const db = database(); const body = envelope(); body.whatsappBusinessAccount.partnerCustomerId = id;
    await expect(acceptYCloudOnboardingEvidence(request(JSON.stringify(body)), config, db.factory)).rejects.toMatchObject({ status: 400 });
    expect(db.factory).not.toHaveBeenCalled();
  });
  it('does not equate payment attachment false with connection failure or activation', async () => {
    const db = database(); const body = envelope(); body.whatsappBusinessAccount.paymentMethodAttached = false;
    expect(await acceptYCloudOnboardingEvidence(request(JSON.stringify(body)), config, db.factory)).toMatchObject({ operational: false });
    expect(db.rpc.mock.calls[0][1].p_payment_method_attached).toBe(false);
  });
});

describe('independent HTTP receiver QA', () => {
  function enable() {
    vi.stubEnv('YCLOUD_ONBOARDING_EVIDENCE_ENABLED', 'true');
    vi.stubEnv('YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE', config.endpointNamespace);
    vi.stubEnv('YCLOUD_WEBHOOK_SECRET', secret);
  }
  it('returns default-disabled 404 no-store without initializing database', async () => {
    vi.stubEnv('YCLOUD_ONBOARDING_EVIDENCE_ENABLED', 'false');
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(adminMock).not.toHaveBeenCalled();
  });
  it('returns 200 only after the RPC commits and never declares operational', async () => {
    enable(); const db = database(); adminMock.mockImplementation(db.factory);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ received: true, duplicate: false, operational: false });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it('returns 503 for thrown database initialization without disclosing errors', async () => {
    enable(); adminMock.mockImplementation(() => { throw new Error(secret); });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'durable_acceptance_failed' });
  });
  it('returns 503 when RPC rejects without acknowledging acceptance', async () => {
    enable(); adminMock.mockReturnValue({ rpc: vi.fn().mockRejectedValue(new Error(secret)) });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'durable_acceptance_failed' });
  });
  it('returns 409 for raw identity conflicts', async () => {
    enable(); const db = database(null, { code: 'YC409' }); adminMock.mockImplementation(db.factory);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'evidence_identity_conflict' });
  });
  it('returns 401 for missing authentication without consulting database', async () => {
    enable(); const unsigned = new Request('https://crm.invalid/api/whatsapp/ycloud/webhook', { method: 'POST', body: JSON.stringify(envelope()) });
    const response = await POST(unsigned);
    expect(response.status).toBe(401); expect(adminMock).not.toHaveBeenCalled();
  });
  it('returns 422 for message events rather than discarding with 200', async () => {
    enable(); const response = await POST(request(JSON.stringify({ ...envelope(), type: 'whatsapp.inbound_message.received' })));
    expect(response.status).toBe(422); expect(adminMock).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
