import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const routeState = vi.hoisted(() => ({
  after: [] as Array<() => Promise<void>>,
  accept: vi.fn(),
  signature: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
  after: (callback: () => Promise<void>) => routeState.after.push(callback),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: routeState.factory }));
vi.mock('./webhook-signature', () => ({
  verifyMetaWebhookSignature: routeState.signature,
}));
vi.mock('./durable/ingress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./durable/ingress')>()),
  acceptMetaIngress: routeState.accept,
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
import { POST } from '@/app/api/whatsapp/webhook/route';
import { MAX_INGRESS_BYTES } from './durable/ingress';
import { drainMetaIngress, type OutboxClaim } from './durable/worker';
import {
  assertDurableConnection,
  assertDurableLease,
  withDurableConnection,
} from './durable/execution-context';
const request = () =>
  new Request('https://crm.invalid/api/whatsapp/webhook', {
    method: 'POST',
    body: '{"entry":[]}',
  });
beforeEach(() => {
  vi.clearAllMocks();
  routeState.after.length = 0;
  routeState.accept.mockResolvedValue({ inserted: 1, received: 1 });
  routeState.signature.mockReturnValue(true);
  routeState.factory.mockReturnValue({});
  vi.stubEnv('WHATSAPP_DURABLE_INGRESS_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('independent durable route QA', () => {
  it('waits for durable acceptance before success and scheduling the worker', async () => {
    let release!: (result: unknown) => void;
    routeState.accept.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = POST(request()).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routeState.accept).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(routeState.after).toHaveLength(0);
    release({ inserted: 1, received: 1 });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(routeState.after).toHaveLength(1);
  });
  it('returns 503 on database failure without scheduling legacy or worker processing', async () => {
    routeState.accept.mockRejectedValue(new Error('FAKE_PRIVATE_DB_CONTENT'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('FAKE_PRIVATE_DB_CONTENT');
    expect(routeState.after).toHaveLength(0);
  });
  it('rejects invalid signature before accessing durable acceptance', async () => {
    routeState.signature.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(routeState.accept).not.toHaveBeenCalled();
    expect(routeState.after).toHaveLength(0);
  });
  it('bounds request size before interpreting payload', async () => {
    const response = await POST(
      new Request('https://crm.invalid/webhook', {
        method: 'POST',
        headers: { 'content-length': String(MAX_INGRESS_BYTES + 1) },
        body: 'x',
      })
    );
    expect(response.status).toBe(413);
    expect(routeState.signature).not.toHaveBeenCalled();
    expect(routeState.accept).not.toHaveBeenCalled();
  });
  it('paused mode refuses acceptance and success instead of falling back to legacy', async () => {
    vi.stubEnv('WHATSAPP_DURABLE_INGRESS_ENABLED', 'paused');
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(routeState.accept).not.toHaveBeenCalled();
    expect(routeState.after).toHaveLength(0);
  });
});
const outbox: OutboxClaim = {
  id: 'outbox-a',
  event_id: 'event-a',
  account_id: 'account-a',
  connection_id: 'connection-a',
  claim_token: 'token-a',
  lease_until: new Date(Date.now() + 300_000).toISOString(),
  payload: { kind: 'inbound_dispatch' },
};
function workerDb(startFails = false, cancelled = false) {
  let returned = false;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'claim_whatsapp_ingress') return { data: [], error: null };
    if (name === 'claim_whatsapp_ingress_outbox') {
      if (returned) return { data: [], error: null };
      returned = true;
      return { data: [outbox], error: null };
    }
    if (name === 'start_whatsapp_ingress_outbox')
      return startFails
        ? { data: null, error: { message: 'checkpoint failed' } }
        : { data: cancelled ? null : outbox.payload, error: null };
    return { data: true, error: null };
  });
  return { db: { rpc } as unknown as SupabaseClient, calls };
}
describe('independent durable worker QA', () => {
  it('does not execute any effect when start checkpoint fails', async () => {
    const { db } = workerDb(true);
    const execute = vi.fn();
    await expect(drainMetaIngress(db, execute, 1)).rejects.toThrow(
      'durable_worker_database_failed'
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('records uncertain after a partial pipeline failure and never repeats it', async () => {
    const { db, calls } = workerDb();
    let effects = 0;
    const execute = vi.fn(async () => {
      effects++;
      throw new Error('synthetic crash after first effect');
    });
    const summary = await drainMetaIngress(db, execute, 2);
    expect(effects).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(summary.uncertain).toBe(1);
    expect(
      calls.filter((call) => call.name === 'finish_whatsapp_ingress_outbox')
    ).toEqual([
      {
        name: 'finish_whatsapp_ingress_outbox',
        args: {
          p_outbox_id: outbox.id,
          p_claim_token: outbox.claim_token,
          p_succeeded: false,
        },
      },
    ]);
    const start = calls.findIndex(
      (call) => call.name === 'start_whatsapp_ingress_outbox'
    );
    expect(start).toBeGreaterThan(-1);
  });
  it('does not run cancelled work when the start RPC returns no payload', async () => {
    const { db } = workerDb(false, true);
    const execute = vi.fn();
    const summary = await drainMetaIngress(db, execute, 1);
    expect(summary.cancelled).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
describe('independent durable context QA', () => {
  const context = {
    accountId: 'account-a',
    connectionId: 'connection-a',
    phoneNumberId: 'phone-a',
    wabaId: 'waba-a',
    deadlineMs: Date.now() + 300_000,
  };
  const config = {
    account_id: 'account-a',
    id: 'connection-a',
    phone_number_id: 'phone-a',
    waba_id: 'waba-a',
  };
  it('prevents changed binding or expired dispatch from starting another effect', async () => {
    await withDurableConnection(context, async () => {
      expect(() => assertDurableConnection({ ...config, id: 'other' })).toThrow(
        'durable_dispatch_connection_changed'
      );
    });
    await withDurableConnection(
      { ...context, deadlineMs: Date.now() - 1 },
      async () => {
        expect(() => assertDurableLease()).toThrow(
          'durable_dispatch_lease_expired'
        );
      }
    );
  });
  it('keeps concurrent asynchronous account contexts separate', async () => {
    await Promise.all([
      withDurableConnection(context, async () => {
        await Promise.resolve();
        assertDurableConnection(config);
        expect(() =>
          assertDurableConnection({ ...config, account_id: 'account-b' })
        ).toThrow();
      }),
      withDurableConnection(
        { ...context, accountId: 'account-b', connectionId: 'connection-b' },
        async () => {
          await Promise.resolve();
          assertDurableConnection({
            ...config,
            account_id: 'account-b',
            id: 'connection-b',
          });
          expect(() => assertDurableConnection(config)).toThrow();
        }
      ),
    ]);
    expect(() => assertDurableLease()).not.toThrow();
  });
});
