import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalId,
  messageTarget,
  type ProviderConnection,
} from './providers/domain';
import { createYCloudProvider } from './providers/ycloud';
import {
  normalizeYCloudWebhook,
  verifyYCloudWebhookSignature,
} from './providers/ycloud-webhook';
import { sendOutbound } from './providers/send-outbound';
const connection: ProviderConnection = {
  accountId: 'account-a',
  connectionId: 'ycloud-a',
  provider: 'ycloud',
};
const creds = { apiKey: 'SUPER_SECRET_UPPERCASE_KEY', from: '+5511999999999' };
const binding = { phoneNumber: creds.from, wabaId: 'waba-a' };
const text = { kind: 'text' as const, to: '+5511888888888', text: 'synthetic' };
const timestamp = 1792110000;
const secret = 'synthetic-webhook-secret';
const raw = '{"synthetic":"ação"}';
function signed(body: string | Uint8Array = raw, t = String(timestamp)) {
  return `t=${t},s=${createHmac('sha256', secret).update(t).update('.').update(body).digest('hex')}`;
}
function fixture(inbound = false) {
  return {
    id: 'event-a',
    type: inbound
      ? 'whatsapp.inbound_message.received'
      : 'whatsapp.message.updated',
    apiVersion: 'v2',
    createTime: '2026-10-15T22:00:00Z',
    [inbound ? 'whatsappInboundMessage' : 'whatsappMessage']: {
      id: 'ycloud-message',
      wamid: 'wamid.synthetic',
      wabaId: 'waba-a',
      from: inbound ? text.to : creds.from,
      to: inbound ? creds.from : text.to,
      status: 'accepted',
      type: 'text',
      text: { body: 'synthetic' },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('independent YCloud signature QA', () => {
  it('authenticates exact raw UTF8 bytes in either input representation', () => {
    expect(
      verifyYCloudWebhookSignature(raw, signed(), secret, {
        nowSeconds: timestamp,
      })
    ).toBe(true);
    expect(
      verifyYCloudWebhookSignature(Buffer.from(raw), signed(), secret, {
        nowSeconds: timestamp,
      })
    ).toBe(true);
    expect(
      verifyYCloudWebhookSignature(raw + ' ', signed(), secret, {
        nowSeconds: timestamp,
      })
    ).toBe(false);
  });
  it.each([-301, -300, 300, 301])(
    'enforces symmetric replay window %s seconds',
    (delta) => {
      expect(
        verifyYCloudWebhookSignature(raw, signed(), secret, {
          nowSeconds: timestamp + delta,
        })
      ).toBe(Math.abs(delta) <= 300);
    }
  );
  it.each([
    't=1,t=1',
    's=' + 'a'.repeat(64) + ',s=' + 'a'.repeat(64),
    't=1.5,s=' + 'a'.repeat(64),
    't=1e3,s=' + 'a'.repeat(64),
    't=-1,s=' + 'a'.repeat(64),
    't=1,s=' + 'z'.repeat(64),
    't=1,s=aa',
  ])('rejects malformed or duplicated header %s', (header) => {
    expect(
      verifyYCloudWebhookSignature(raw, header, secret, {
        nowSeconds: timestamp,
      })
    ).toBe(false);
  });
  it('rejects missing secret/header and invalid clock values', () => {
    expect(
      verifyYCloudWebhookSignature(raw, signed(), '', { nowSeconds: timestamp })
    ).toBe(false);
    expect(verifyYCloudWebhookSignature(raw, null, secret)).toBe(false);
    expect(
      verifyYCloudWebhookSignature(raw, signed(), secret, { nowSeconds: NaN })
    ).toBe(false);
  });
});
describe('independent YCloud adapter QA', () => {
  it('binds from and snapshots credentials, preserving YCloud ID separately from wamid', async () => {
    const mutable = { ...creds };
    const provider = createYCloudProvider(connection, mutable);
    mutable.from = '+15551234567';
    mutable.apiKey = 'changed';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'ycloud-message',
          wamid: 'wamid.synthetic',
          status: 'accepted',
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendOutbound('account-a', provider, text);
    expect(result).toEqual(
      externalId(connection, 'ycloud-message', 'wamid.synthetic')
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.ycloud.com/v2/whatsapp/messages/sendDirectly'
    );
    expect(init.headers['X-API-Key']).toBe(creds.apiKey);
    expect(JSON.parse(init.body)).toMatchObject({
      from: creds.from,
      to: text.to,
    });
    expect(JSON.stringify(JSON.parse(init.body))).not.toContain(creds.apiKey);
  });
  it.each(['reply', 'reaction'])(
    'uses transport wamid for %s instead of YCloud resource ID',
    async (kind) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: 'new', wamid: 'wamid.new' }))
        );
      vi.stubGlobal('fetch', fetchMock);
      const target = externalId(connection, 'ycloud-resource', 'wamid.target');
      await createYCloudProvider(connection, creds).messaging.send(
        kind === 'reply'
          ? { ...text, replyTo: target }
          : { kind: 'reaction', to: text.to, target, emoji: '👍' }
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(
        kind === 'reply' ? body.context.message_id : body.reaction.message_id
      ).toBe('wamid.target');
    }
  );
  it('rejects missing transport ID and cross-account targets before network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createYCloudProvider(connection, creds);
    await expect(
      provider.messaging.send({
        ...text,
        replyTo: externalId(connection, 'resource-only'),
      })
    ).rejects.toThrow();
    await expect(
      provider.messaging.send({
        ...text,
        replyTo: externalId(
          { ...connection, accountId: 'other' },
          'resource',
          'wamid'
        ),
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => messageTarget(externalId(connection, 'resource'))).toThrow();
  });
  it.each(['5511888888888', '+05511888888888', '+1234567890123456'])(
    'rejects invalid E164 recipient %s before network',
    async (to) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        createYCloudProvider(connection, creds).messaging.send({ ...text, to })
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it.each([
    [401, 'rejected'],
    [429, 'retryable'],
    [500, 'uncertain'],
  ] as const)(
    'classifies HTTP %s without retry or secret echo',
    async (status, outcome) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: creds.apiKey, message: creds.apiKey },
          }),
          { status }
        )
      );
      vi.stubGlobal('fetch', fetchMock);
      const error = await createYCloudProvider(connection, creds)
        .messaging.send(text)
        .catch((e) => e);
      expect(error).toMatchObject({ outcome });
      expect(error.message).not.toContain(creds.apiKey);
      expect(error.code).not.toContain(creds.apiKey);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it('never echoes an uppercase API key from successful failed errorCode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'rejected',
            status: 'failed',
            errorCode: creds.apiKey,
          })
        )
      )
    );
    const error = await createYCloudProvider(connection, creds)
      .messaging.send(text)
      .catch((e) => e);
    expect(error).toMatchObject({ outcome: 'rejected' });
    expect(error.message).not.toContain(creds.apiKey);
    expect(error.code).not.toContain(creds.apiKey);
  });
  it.each([
    '{}',
    'not-json',
    '{"id":" "}',
    '{"id":"ok","from":"+15551234567"}',
  ])('marks malformed accepted response uncertain: %s', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createYCloudProvider(connection, creds).messaging.send(text)
    ).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
describe('independent YCloud event normalization QA', () => {
  it('preserves accepted as a distinct state and both message IDs', () => {
    const event = normalizeYCloudWebhook(
      JSON.stringify(fixture()),
      connection,
      binding
    );
    expect(event).toMatchObject({
      kind: 'delivery',
      status: 'accepted',
      event: externalId(connection, 'event-a'),
      message: externalId(connection, 'ycloud-message', 'wamid.synthetic'),
    });
  });
  it('normalizes inbound text under a separately namespaced event', () => {
    const body = JSON.stringify(fixture(true));
    const event = normalizeYCloudWebhook(body, connection, binding);
    expect(event).toMatchObject({
      kind: 'inbound',
      from: text.to,
      to: creds.from,
      content: { kind: 'text', text: 'synthetic' },
    });
    const other = normalizeYCloudWebhook(
      body,
      { ...connection, connectionId: 'other' },
      binding
    );
    expect(event?.event).not.toEqual(other?.event);
  });
  it.each(['from', 'wabaId'])(
    'rejects mismatched server binding field %s',
    (field) => {
      const body = fixture();
      const message = body.whatsappMessage as Record<string, unknown>;
      message[field] = field === 'from' ? '+15551234567' : 'other-waba';
      expect(() =>
        normalizeYCloudWebhook(JSON.stringify(body), connection, binding)
      ).toThrow();
    }
  );
  it.each(['id', 'apiVersion', 'createTime'])(
    'rejects invalid envelope %s',
    (field) => {
      const body = fixture() as Record<string, unknown>;
      body[field] = field === 'apiVersion' ? 'v1' : '';
      expect(() =>
        normalizeYCloudWebhook(JSON.stringify(body), connection, binding)
      ).toThrow();
    }
  );
  it('ignores unimplemented event types rather than guessing a message DTO', () => {
    expect(
      normalizeYCloudWebhook(
        JSON.stringify({ type: 'sms.message.updated' }),
        connection,
        binding
      )
    ).toBeNull();
  });
});

it('rejects an impossible calendar date instead of normalizing it into another month', () => {
  const event = { ...fixture(), createTime: '2026-02-31T22:00:00Z' };
  expect(() =>
    normalizeYCloudWebhook(JSON.stringify(event), connection, binding)
  ).toThrow();
});

it('distinguishes account namespaces even for identical signed provider event IDs', () => {
  const body = JSON.stringify(fixture());
  const a = normalizeYCloudWebhook(body, connection, binding);
  const b = normalizeYCloudWebhook(
    body,
    { ...connection, accountId: 'account-b' },
    binding
  );
  expect(a?.event).not.toEqual(b?.event);
});

it('rejects inbound messages addressed to another configured number', () => {
  const body = fixture(true);
  (body.whatsappInboundMessage as Record<string, unknown>).to = '+15551234567';
  expect(() =>
    normalizeYCloudWebhook(JSON.stringify(body), connection, binding)
  ).toThrow();
});

it('treats lost transport as uncertain and performs one request', async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValue(new TypeError('synthetic disconnected'));
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    createYCloudProvider(connection, creds).messaging.send(text)
  ).rejects.toMatchObject({ outcome: 'uncertain', code: 'transport_error' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('refuses a Meta connection instead of selecting another vendor automatically', () => {
  expect(() =>
    createYCloudProvider({ ...connection, provider: 'meta_cloud' }, creds)
  ).toThrow();
});

it('does not expose raw private content when malformed JSON cannot be normalized', () => {
  const privateBody = 'FAKE_PRIVATE_CONTENT';
  let error: unknown;
  try {
    normalizeYCloudWebhook(privateBody, connection, binding);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('FAKE_PRI');
});

it.each([
  '2025-02-29T22:00:00Z',
  '2026-04-31T22:00:00Z',
  '2026-10-15T24:00:00Z',
  '2026-10-15T22:60:00Z',
])('rejects an invalid RFC3339 calendar or clock %s', (createTime) => {
  expect(() =>
    normalizeYCloudWebhook(
      JSON.stringify({ ...fixture(), createTime }),
      connection,
      binding
    )
  ).toThrow();
});
it.each(['2024-02-29T22:00:00Z', '2026-10-15T19:00:00-03:00'])(
  'accepts a valid leap date or explicit offset %s',
  (createTime) => {
    expect(
      normalizeYCloudWebhook(
        JSON.stringify({ ...fixture(), createTime }),
        connection,
        binding
      )
    ).toMatchObject({ occurredAt: createTime });
  }
);
