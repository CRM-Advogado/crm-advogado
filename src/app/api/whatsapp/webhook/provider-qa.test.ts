import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  concurrentDelivery: false,
  after: [] as Array<() => Promise<void>>,
  recipients: [
    {
      id: 'ra',
      whatsapp_message_id: 'collision',
      account_id: 'account-a',
      status: 'sent',
    },
    {
      id: 'rb',
      whatsapp_message_id: 'collision',
      account_id: 'account-b',
      status: 'sent',
    },
  ],
  messages: [
    {
      id: 'a',
      message_id: 'collision',
      conversation_id: 'conv-a',
      account_id: 'account-a',
      status: 'sent',
    },
    {
      id: 'b',
      message_id: 'collision',
      conversation_id: 'conv-b',
      account_id: 'account-b',
      status: 'sent',
    },
  ],
}));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
  after: (cb: () => Promise<void>) => state.after.push(cb),
}));
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: dispatch }));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      let update: Record<string, unknown> | undefined;
      const filters: Array<[string, unknown]> = [];
      let multiple = false;
      const result = () => {
        if (table === 'whatsapp_config')
          return {
            data: multiple
              ? [
                  {
                    id: 'cfg-a',
                    phone_number_id: 'phone-a',
                    account_id: 'account-a',
                    user_id: 'user-a',
                    access_token: 'unused',
                  },
                ]
              : {
                  id: 'cfg-a',
                  phone_number_id: 'phone-a',
                  account_id: 'account-a',
                  user_id: 'user-a',
                  access_token: 'unused',
                },
            error: null,
          };
        if (table === 'conversations')
          return {
            data: [{ id: 'conv-a', account_id: 'account-a' }],
            error: null,
          };
        if (table === 'broadcast_recipients')
          return { data: null, error: null };
        const rows = state.messages.filter((row) =>
          filters.every(([key, value]) => {
            if (
              key === 'conversations.account_id' ||
              key === 'broadcasts.account_id'
            )
              return row.account_id === value;
            if (Array.isArray(value))
              return value.includes(row[key as keyof typeof row]);
            return row[key as keyof typeof row] === value;
          })
        );
        if (update) rows.forEach((row) => Object.assign(row, update));
        const mapped = rows.map((row) => ({
          ...row,
          conversations: { account_id: row.account_id },
        }));
        return { data: multiple ? mapped : (mapped[0] ?? null), error: null };
      };
      const builder = {
        select: () => {
          multiple = true;
          return builder;
        },
        update: (value: Record<string, unknown>) => {
          update = value;
          return builder;
        },
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return builder;
        },
        in: (key: string, value: unknown[]) => {
          filters.push([key, value]);
          return builder;
        },
        limit: () => builder,
        maybeSingle: () => {
          multiple = false;
          return Promise.resolve(result());
        },
        single: () => {
          multiple = false;
          return Promise.resolve(result());
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  }),
}));
import { POST } from './route';
beforeEach(() => {
  state.after.length = 0;
  state.concurrentDelivery = false;
  state.messages.forEach((row) => {
    row.status = 'sent';
  });
  state.recipients.forEach((row) => {
    row.status = 'sent';
  });
  dispatch.mockClear();
});
it('scopes status updates by the signed webhook phone connection when external IDs collide', async () => {
  const response = await POST(
    new Request('https://crm.invalid/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            id: 'waba-a',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-a' },
                  statuses: [
                    {
                      id: 'collision',
                      status: 'read',
                      timestamp: '1792110000',
                      recipient_id: '5511999999999',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    })
  );
  expect(response.status).toBe(200);
  for (const callback of state.after) await callback();
  expect(state.messages[0].status).toBe('read');
  expect(state.messages[1].status).toBe('sent');
  expect(state.recipients[1].status).toBe('sent');
  expect(dispatch.mock.calls.every((call) => call[1] === 'account-a')).toBe(
    true
  );
});

it('does not regress a read inbox message when a delayed sent status arrives', async () => {
  state.messages[0].status = 'read';
  await POST(
    new Request('https://crm.invalid/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            id: 'waba-a',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-a' },
                  statuses: [
                    {
                      id: 'collision',
                      status: 'sent',
                      timestamp: '1792110000',
                      recipient_id: '5511999999999',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    })
  );
  for (const callback of state.after) await callback();
  expect(state.messages[0].status).toBe('read');
  expect(state.messages[1].status).toBe('sent');
  expect(state.recipients[1].status).toBe('sent');
});

it('preserves read when another worker advances sent to delivered between read and update', async () => {
  state.concurrentDelivery = true;
  await POST(
    new Request('https://crm.invalid/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            id: 'waba-a',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-a' },
                  statuses: [
                    {
                      id: 'collision',
                      status: 'read',
                      timestamp: '1792110000',
                      recipient_id: '5511999999999',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    })
  );
  for (const callback of state.after) await callback();
  expect(state.messages[0].status).toBe('read');
});

it('advances a newly sending message to sent', async () => {
  state.messages[0].status = 'sending';
  await POST(
    new Request('https://crm.invalid/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            id: 'waba-a',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-a' },
                  statuses: [
                    {
                      id: 'collision',
                      status: 'sent',
                      timestamp: '1792110000',
                      recipient_id: '5511999999999',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    })
  );
  for (const callback of state.after) await callback();
  expect(state.messages[0].status).toBe('sent');
  expect(dispatch).toHaveBeenCalledTimes(1);
});
