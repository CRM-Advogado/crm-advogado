import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMetaOutboxExecutor } from './dispatch';
import type { OutboxClaim } from './worker';

const mocks = vi.hoisted(() => ({
  flow: vi.fn(),
  automation: vi.fn(),
  ai: vi.fn(),
  webhook: vi.fn(),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mocks.flow }));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.automation,
}));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: mocks.ai }));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: mocks.webhook,
}));

const claim: OutboxClaim = {
  id: 'effect',
  event_id: 'event',
  account_id: 'account',
  connection_id: 'config',
  claim_token: 'claim',
  lease_until: new Date(Date.now() + 300000).toISOString(),
  payload: {},
};
const payload = {
  kind: 'inbound_dispatch',
  conversation_id: 'conversation',
  contact_id: 'contact',
  message_id: 'message',
  first_inbound: true,
  was_created: true,
  conversation_created: true,
};
function database(options: { reply?: string; revoked?: boolean } = {}) {
  const rows: Record<string, unknown> = {
    whatsapp_ingress_events: {
      account_id: 'account',
      connection_id: 'config',
      phone_number_id: 'number',
      waba_id: 'waba',
      owner_user_id: 'owner',
    },
    whatsapp_config: {
      id: 'config',
      account_id: 'account',
      phone_number_id: options.revoked ? 'another-number' : 'number',
      waba_id: 'waba',
      user_id: 'owner',
      status: 'connected',
    },
    conversations: { id: 'conversation', contact_id: 'contact' },
    messages: {
      message_id: 'wamid',
      content_text: 'Hello',
      content_type: 'text',
      interactive_reply_id: options.reply ?? null,
    },
  };
  return {
    from: vi.fn((table: string) => {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(async () => ({ data: rows[table], error: null })),
      };
      return query;
    }),
  } as unknown as SupabaseClient;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.flow.mockResolvedValue({ consumed: false });
  mocks.automation.mockResolvedValue(undefined);
  mocks.ai.mockResolvedValue(undefined);
  mocks.webhook.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('durable legacy pipeline equivalence and conservative failure', () => {
  it('a consumed flow suppresses content automations and AI but preserves relationship triggers', async () => {
    mocks.flow.mockResolvedValue({ consumed: true });
    await createMetaOutboxExecutor(database())(claim, payload);
    expect(
      mocks.automation.mock.calls.map((call) => call[0].triggerType)
    ).toEqual(['first_inbound_message', 'new_contact_created']);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.webhook.mock.calls.map((call) => call[2])).toEqual([
      'conversation.created',
      'message.received',
    ]);
    expect(mocks.flow).toHaveBeenCalledWith(
      expect.objectContaining({
        isFirstInboundMessage: true,
        message: { kind: 'text', text: 'Hello', meta_message_id: 'wamid' },
      })
    );
  });

  it('runs flow, automations and AI in that order for plain text', async () => {
    const order: string[] = [];
    mocks.flow.mockImplementation(async () => {
      order.push('flow');
      return { consumed: false };
    });
    mocks.automation.mockImplementation(async () => {
      order.push('automation');
    });
    mocks.ai.mockImplementation(async () => {
      order.push('ai');
    });
    await createMetaOutboxExecutor(database())(claim, {
      ...payload,
      was_created: false,
      first_inbound: false,
    });
    expect(order).toEqual(['flow', 'automation', 'automation', 'ai']);
    expect(
      mocks.automation.mock.calls.map((call) => call[0].triggerType)
    ).toEqual(['new_message_received', 'keyword_match']);
  });

  it('an interactive reply has its trigger and never invokes AI', async () => {
    await createMetaOutboxExecutor(database({ reply: 'button-choice' }))(
      claim,
      { ...payload, was_created: false, first_inbound: false }
    );
    expect(
      mocks.automation.mock.calls.map((call) => call[0].triggerType)
    ).toEqual(['new_message_received', 'keyword_match', 'interactive_reply']);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it('fails before engines when the bound number was changed or revoked', async () => {
    await expect(
      createMetaOutboxExecutor(database({ revoked: true }))(claim, payload)
    ).rejects.toThrow('outbox_connection_revoked');
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });

  it('does not continue the remaining actions after a partially executed pipeline throws', async () => {
    mocks.automation.mockRejectedValueOnce(
      new Error('engine failed after an earlier effect')
    );
    await expect(
      createMetaOutboxExecutor(database())(claim, payload)
    ).rejects.toThrow();
    expect(mocks.flow).toHaveBeenCalledTimes(1);
    expect(mocks.automation).toHaveBeenCalledTimes(1);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.webhook.mock.calls.map((call) => call[2])).toEqual([
      'conversation.created',
    ]);
  });

  it('an old worker stops initiating new actions after its wall-clock lease deadline', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mocks.flow.mockImplementation(async () => {
      vi.setSystemTime(now + 3000);
      return { consumed: false };
    });
    await expect(
      createMetaOutboxExecutor(database())(
        { ...claim, lease_until: new Date(now + 1000).toISOString() },
        payload
      )
    ).rejects.toThrow('durable_dispatch_lease_expired');
    expect(mocks.automation).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
});
