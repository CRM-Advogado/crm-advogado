import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { acceptMetaIngress, prepareMetaIngress } from './ingress';

const config = {
  id: 'config-a',
  account_id: 'account-a',
  phone_number_id: 'number-a',
  waba_id: 'waba-a',
  status: 'connected',
};
const message = (id = 'message-1', from = '5511999999999') => ({
  id,
  from,
  timestamp: '1800000000',
  type: 'text',
  text: { body: 'Olá' },
});
const envelope = (value: Record<string, unknown>, field = 'messages') => ({
  entry: [
    {
      id: 'waba-a',
      changes: [
        {
          field,
          value: { metadata: { phone_number_id: 'number-a' }, ...value },
        },
      ],
    },
  ],
});
function database(configs: unknown[] = [config]) {
  const query = { eq: vi.fn().mockReturnThis(), then: undefined as unknown };
  query.then = (resolve: (result: unknown) => unknown) =>
    resolve({ data: configs, error: null });
  const db = {
    from: vi.fn(() => ({ select: () => query })),
    rpc: vi.fn(async () => ({
      data: { inserted: 1, received: 1 },
      error: null,
    })),
  };
  return { db: db as unknown as SupabaseClient, rpc: db.rpc, query };
}
afterEach(() => vi.restoreAllMocks());

describe('durable Meta event preparation', () => {
  it('matches batch contact profiles by wa_id instead of array position', async () => {
    const { db } = database();
    const body = envelope({
      messages: [message('a', '5511000000001'), message('b', '5511000000002')],
      contacts: [
        { wa_id: '5511000000002', profile: { name: 'Second' } },
        { wa_id: '5511000000001', profile: { name: 'First' } },
      ],
    });
    const result = await prepareMetaIngress(db, body);
    expect(result.items.map((item) => item.payload.name)).toEqual([
      'First',
      'Second',
    ]);
    expect(result.items.map((item) => item.account_id)).toEqual([
      'account-a',
      'account-a',
    ]);
  });

  it('persists only the required event fragment, not unrelated contact data or headers', async () => {
    const { db } = database();
    const result = await prepareMetaIngress(
      db,
      envelope({
        messages: [
          {
            ...message(),
            referral: {
              source_id: 'ad',
              ctwa_clid: 'click',
              private_unneeded: 'not-persisted',
            },
          },
        ],
        contacts: [
          { wa_id: 'unrelated', profile: { name: 'Other account name' } },
        ],
        credentials: 'not-persisted',
      })
    );
    const item = result.items[0];
    expect(item.payload.name).toBeNull();
    expect(item.payload.referral).toMatchObject({
      source_id: 'ad',
      ctwa_clid: 'click',
    });
    expect(JSON.stringify(item)).not.toContain('not-persisted');
    expect(JSON.stringify(item)).not.toContain('Other account');
  });

  it('replays message and status identities deterministically and separates status transitions', async () => {
    const { db } = database();
    const body = envelope({
      messages: [message()],
      statuses: [
        {
          id: 'outbound',
          status: 'sent',
          timestamp: '1800000000',
          recipient_id: '5511000000001',
        },
        {
          id: 'outbound',
          status: 'read',
          timestamp: '1800000001',
          recipient_id: '5511000000001',
        },
      ],
    });
    const first = await prepareMetaIngress(db, body),
      second = await prepareMetaIngress(db, body);
    expect(first).toEqual(second);
    expect(new Set(first.items.map((item) => item.event_key)).size).toBe(3);
  });

  it('media needs no provider call before acceptance, and reactions remain separate from messages', async () => {
    const { db } = database();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('should not call network'));
    const result = await prepareMetaIngress(
      db,
      envelope({
        messages: [
          {
            ...message('media'),
            type: 'document',
            document: { id: 'opaque/media', filename: 'file.pdf' },
          },
          {
            ...message('reaction'),
            type: 'reaction',
            reaction: { message_id: 'parent', emoji: '' },
          },
        ],
      })
    );
    expect(result.items[0].payload).toMatchObject({
      content_type: 'document',
      content_text: 'file.pdf',
      media_url: '/api/whatsapp/media/opaque%2Fmedia',
    });
    expect(result.items[1]).toMatchObject({
      event_kind: 'reaction',
      payload: { reaction_target_id: 'parent', emoji: '' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not merge distinct canonical international numbers by their last digits', async () => {
    const { db } = database();
    const result = await prepareMetaIngress(
      db,
      envelope({
        messages: [
          message('one', '5511999999999'),
          message('two', '4411999999999'),
        ],
      })
    );
    expect(result.items.map((item) => item.payload.phone)).toEqual([
      '5511999999999',
      '4411999999999',
    ]);
  });

  it('rejects the entire malformed batch before enqueueing its valid subset', async () => {
    const { db, rpc } = database();
    await expect(
      acceptMetaIngress(
        db,
        envelope({
          messages: [message(), { ...message('bad'), timestamp: 'not-a-time' }],
        })
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('template status is account-scoped; missing source time does not deduplicate a future same-state cycle', async () => {
    const { db } = database();
    const body = envelope(
      { message_template_id: 'template', event: 'APPROVED' },
      'message_template_status_update'
    );
    const first = await prepareMetaIngress(db, body),
      second = await prepareMetaIngress(db, body);
    expect(first.items[0]).toMatchObject({
      account_id: 'account-a',
      event_kind: 'template_status',
      payload: { status: 'APPROVED', template_id: 'template' },
    });
    expect(first.items[0].event_key).not.toBe(second.items[0].event_key);
    const timed = {
      ...body,
      entry: body.entry.map((entry) => ({ ...entry, time: 1800000000 })),
    };
    expect((await prepareMetaIngress(db, timed)).items[0].event_key).toBe(
      (await prepareMetaIngress(db, timed)).items[0].event_key
    );
  });

  it('a persistence failure is never acknowledged as durable acceptance', async () => {
    const { db, rpc } = database();
    rpc.mockResolvedValueOnce({
      data: null as never,
      error: { message: 'private database detail' } as never,
    });
    await expect(
      acceptMetaIngress(db, envelope({ messages: [message()] }))
    ).rejects.toMatchObject({
      status: 503,
      message: 'durable_acceptance_failed',
    });
  });
});
