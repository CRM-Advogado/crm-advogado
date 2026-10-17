import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalId,
  messageTarget,
  type OutboundMessage,
  type ProviderConnection,
} from './domain';
import { sendOutbound } from './send-outbound';
import { createYCloudProvider } from './ycloud';
import {
  normalizeYCloudWebhook,
  verifyYCloudWebhookSignature,
} from './ycloud-webhook';

const connection: ProviderConnection = {
  accountId: 'office',
  connectionId: 'ycloud-number',
  provider: 'ycloud',
};
const credentials = { apiKey: 'DUMMY_PRIVATE_KEY', from: '+5511999999999' };
const recipient = '+5511888888888';
const base = { from: credentials.from, to: recipient };
const reference = externalId(connection, 'ycloud-resource', 'wamid.original');
const text: OutboundMessage = { kind: 'text', to: recipient, text: 'Olá' };
afterEach(() => vi.unstubAllGlobals());

function fetchSuccess(
  data: unknown = {
    id: 'ycloud-resource',
    wamid: 'wamid.original',
    status: 'sent',
  }
) {
  const mock = vi.fn(async () => Response.json(data));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('YCloud official sendDirectly wire contract', () => {
  const cases: { label: string; message: OutboundMessage; body: unknown }[] = [
    {
      label: 'text replies use wamid, never the YCloud resource ID',
      message: { ...text, replyTo: reference },
      body: {
        ...base,
        type: 'text',
        text: { body: 'Olá' },
        context: { message_id: 'wamid.original' },
      },
    },
    ...(['image', 'video', 'document', 'audio'] as const).map((mediaKind) => ({
      label: `${mediaKind} by public URL`,
      message: {
        kind: 'media' as const,
        to: recipient,
        mediaKind,
        url: 'https://example.com/file',
        caption: 'Caption',
        filename: 'file.pdf',
      },
      body: {
        ...base,
        type: mediaKind,
        [mediaKind]: {
          link: 'https://example.com/file',
          ...(mediaKind === 'audio' ? {} : { caption: 'Caption' }),
          ...(mediaKind === 'document' ? { filename: 'file.pdf' } : {}),
        },
      },
    })),
    {
      label: 'approved template carries neutral slots and media IDs',
      message: {
        kind: 'template',
        to: recipient,
        name: 'contract',
        language: 'pt_BR',
        slots: [
          {
            location: 'header',
            values: [
              {
                kind: 'media',
                mediaKind: 'document',
                reference: externalId(connection, 'media-id'),
              },
            ],
          },
          { location: 'body', values: [{ kind: 'text', value: 'Ana' }] },
          {
            location: 'button',
            action: 'url',
            index: 0,
            values: [{ kind: 'text', value: 'suffix' }],
          },
        ],
      },
      body: {
        ...base,
        type: 'template',
        template: {
          name: 'contract',
          language: { code: 'pt_BR' },
          components: [
            {
              type: 'header',
              parameters: [{ type: 'document', document: { id: 'media-id' } }],
            },
            { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: 'suffix' }],
            },
          ],
        },
      },
    },
    {
      label: 'reply buttons',
      message: {
        kind: 'buttons',
        to: recipient,
        body: 'Choose',
        header: 'Header',
        footer: 'Footer',
        buttons: [{ id: 'yes', title: 'Yes' }],
      },
      body: {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Choose' },
          header: { type: 'text', text: 'Header' },
          footer: { text: 'Footer' },
          action: {
            buttons: [{ type: 'reply', reply: { id: 'yes', title: 'Yes' } }],
          },
        },
      },
    },
    {
      label: 'list',
      message: {
        kind: 'list',
        to: recipient,
        body: 'Choose',
        buttonLabel: 'Open',
        sections: [{ title: 'Options', rows: [{ id: 'one', title: 'One' }] }],
      },
      body: {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Choose' },
          action: {
            button: 'Open',
            sections: [
              { title: 'Options', rows: [{ id: 'one', title: 'One' }] },
            ],
          },
        },
      },
    },
    {
      label: 'reaction removal',
      message: {
        kind: 'reaction',
        to: recipient,
        target: reference,
        emoji: '',
      },
      body: {
        ...base,
        type: 'reaction',
        reaction: { message_id: 'wamid.original', emoji: '' },
      },
    },
  ];
  for (const fixture of cases)
    it(fixture.label, async () => {
      const fetchMock = fetchSuccess();
      const result = await sendOutbound(
        'office',
        createYCloudProvider(connection, credentials),
        fixture.message
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        'https://api.ycloud.com/v2/whatsapp/messages/sendDirectly'
      );
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          'X-API-Key': credentials.apiKey,
          'Content-Type': 'application/json',
        },
      });
      expect(JSON.parse(String(init.body))).toEqual(fixture.body);
      expect(result).toEqual(reference);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

  it('snapshots credentials and bound sender before caller mutation', async () => {
    const mutableCredentials = { ...credentials };
    const mutableConnection = { ...connection };
    const provider = createYCloudProvider(
      mutableConnection,
      mutableCredentials
    );
    mutableCredentials.from = '+123456789';
    mutableCredentials.apiKey = 'OTHER';
    mutableConnection.accountId = 'other';
    const fetchMock = fetchSuccess();
    await provider.messaging.send(text);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body)).from).toBe(credentials.from);
    expect(init.headers).toMatchObject({ 'X-API-Key': credentials.apiKey });
    expect(provider.connection.accountId).toBe('office');
  });

  it('accepts a resource without wamid but refuses to invent a reply target', async () => {
    const fetchMock = fetchSuccess({ id: 'resource-only', status: 'accepted' });
    const provider = createYCloudProvider(connection, credentials);
    const result = await sendOutbound('office', provider, text);
    expect(result).toEqual(externalId(connection, 'resource-only'));
    expect(() => messageTarget(result)).toThrow(/reconciled/);
    await expect(
      sendOutbound('office', provider, { ...text, replyTo: result })
    ).rejects.toThrow(/reconciled/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-connection reaction targets and unnormalized phone numbers before fetching', async () => {
    const fetchMock = fetchSuccess();
    const provider = createYCloudProvider(connection, credentials);
    await expect(
      provider.messaging.send({
        kind: 'reaction',
        to: recipient,
        target: externalId(
          { ...connection, connectionId: 'other' },
          'id',
          'wamid.other'
        ),
        emoji: '👍',
      })
    ).rejects.toThrow(/different connection/);
    await expect(
      provider.messaging.send({ ...text, to: recipient.slice(1) })
    ).rejects.toMatchObject({ code: 'invalid_recipient' });
    expect(() =>
      createYCloudProvider(connection, {
        ...credentials,
        from: '5511999999999',
      })
    ).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('YCloud failure semantics do not replay uncertain sends', () => {
  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'retryable'],
    [500, 'uncertain'],
    [503, 'uncertain'],
  ] as const)(
    'HTTP %s is %s and never reflects a private provider body',
    async (status, outcome) => {
      const fetchMock = vi.fn(async () =>
        Response.json(
          { error: { code: credentials.apiKey, message: credentials.apiKey } },
          { status }
        )
      );
      vi.stubGlobal('fetch', fetchMock);
      const error = await createYCloudProvider(connection, credentials)
        .messaging.send(text)
        .catch((error) => error);
      expect(error).toMatchObject({
        code: `http_${status}`,
        outcome,
        httpStatus: status,
      });
      expect(error.message).not.toContain(credentials.apiKey);
      expect(JSON.stringify(error)).not.toContain(credentials.apiKey);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    {},
    { id: '' },
    { id: 'resource', wamid: '' },
    { id: 'resource', from: recipient },
    { id: 'resource', to: credentials.from },
  ])('a malformed success remains uncertain: %j', async (data) => {
    const fetchMock = fetchSuccess(data);
    await expect(
      createYCloudProvider(connection, credentials).messaging.send(text)
    ).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lost transport or malformed JSON cannot become a definitive refusal', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('{"id":'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createYCloudProvider(connection, credentials);
    await expect(provider.messaging.send(text)).rejects.toMatchObject({
      code: 'transport_error',
      outcome: 'uncertain',
    });
    await expect(provider.messaging.send(text)).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'uncertain',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a documented failed resource is a rejection without reflecting errorCode', async () => {
    fetchSuccess({
      id: 'resource',
      status: 'failed',
      errorCode: credentials.apiKey,
      errorMessage: credentials.apiKey,
    });
    await expect(
      createYCloudProvider(connection, credentials).messaging.send(text)
    ).rejects.toMatchObject({
      code: 'provider_rejected',
      outcome: 'rejected',
      message: 'YCloud send failed (provider_rejected)',
    });
  });
});

const nowSeconds = 1_800_000_000;
const secret = 'dummy-endpoint-secret';
function signature(rawBody: string | Uint8Array, timestamp = nowSeconds) {
  const digest = createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(rawBody)
    .digest('hex');
  return `t=${timestamp},s=${digest}`;
}

describe('YCloud signature authentication over raw bytes', () => {
  it('authenticates Unicode bytes and rejects whitespace or parsed/reserialized changes', () => {
    const raw = '{ "text": "oração" }\n';
    const bytes = new TextEncoder().encode(raw);
    expect(
      verifyYCloudWebhookSignature(bytes, signature(bytes), secret, {
        nowSeconds,
      })
    ).toBe(true);
    expect(
      verifyYCloudWebhookSignature(raw, signature(raw), secret, { nowSeconds })
    ).toBe(true);
    expect(
      verifyYCloudWebhookSignature(
        JSON.stringify(JSON.parse(raw)),
        signature(raw),
        secret,
        { nowSeconds }
      )
    ).toBe(false);
  });
  it.each([-301, 301])(
    'rejects a correctly signed timestamp outside the window (%s seconds)',
    (offset) => {
      expect(
        verifyYCloudWebhookSignature(
          '{}',
          signature('{}', nowSeconds + offset),
          secret,
          { nowSeconds }
        )
      ).toBe(false);
    }
  );
  it('rejects missing secrets, duplicate fields and unsupported header encodings', () => {
    const valid = signature('{}');
    for (const header of [
      null,
      '',
      `${valid},t=${nowSeconds}`,
      valid.replace('t=', 'timestamp='),
      valid.replace('s=', 'v1='),
      `t=${nowSeconds},s=ff`,
    ]) {
      expect(
        verifyYCloudWebhookSignature('{}', header, secret, { nowSeconds })
      ).toBe(false);
    }
    expect(verifyYCloudWebhookSignature('{}', valid, '', { nowSeconds })).toBe(
      false
    );
    expect(
      verifyYCloudWebhookSignature('{}', valid, 'wrong', { nowSeconds })
    ).toBe(false);
  });
});

const binding = { phoneNumber: credentials.from, wabaId: 'waba-owned' };
function statusEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'event-1',
    type: 'whatsapp.message.updated',
    apiVersion: 'v2',
    createTime: '2026-10-15T12:00:00Z',
    whatsappMessage: {
      id: 'resource-1',
      wamid: 'wamid-1',
      from: credentials.from,
      to: recipient,
      wabaId: binding.wabaId,
      status: 'accepted',
      ...overrides,
    },
  });
}
function inboundEvent(
  content: Record<string, unknown> = { type: 'text', text: { body: 'Hello' } }
) {
  return JSON.stringify({
    id: 'event-2',
    type: 'whatsapp.inbound_message.received',
    apiVersion: 'v2',
    createTime: '2026-10-15T12:00:00Z',
    whatsappInboundMessage: {
      id: 'inbound-1',
      wamid: 'wamid-inbound',
      from: recipient,
      to: credentials.from,
      wabaId: binding.wabaId,
      ...content,
    },
  });
}

describe('YCloud pure fixture normalization after authentication', () => {
  it('keeps accepted distinct from sent and namespaces event and message identities', () => {
    const result = normalizeYCloudWebhook(statusEvent(), connection, binding);
    expect(result).toMatchObject({
      kind: 'delivery',
      status: 'accepted',
      event: externalId(connection, 'event-1'),
      message: externalId(connection, 'resource-1', 'wamid-1'),
    });
  });
  it('cannot bind a validly shaped event to another number or WABA', () => {
    expect(() =>
      normalizeYCloudWebhook(
        statusEvent({ from: recipient }),
        connection,
        binding
      )
    ).toThrow(/configured connection/);
    expect(() =>
      normalizeYCloudWebhook(
        statusEvent({ wabaId: 'other' }),
        connection,
        binding
      )
    ).toThrow(/configured connection/);
    expect(() =>
      normalizeYCloudWebhook(
        inboundEvent({ to: recipient }),
        connection,
        binding
      )
    ).toThrow(/configured connection/);
  });
  it('normalizes individual text, media and list selections without fetching', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      normalizeYCloudWebhook(inboundEvent(), connection, binding)
    ).toMatchObject({
      kind: 'inbound',
      from: recipient,
      to: credentials.from,
      content: { kind: 'text', text: 'Hello' },
    });
    expect(
      normalizeYCloudWebhook(
        inboundEvent({
          type: 'audio',
          audio: {
            id: 'media-1',
            link: 'https://example.com/media',
            mime_type: 'audio/ogg',
          },
        }),
        connection,
        binding
      )
    ).toMatchObject({
      content: {
        kind: 'media',
        mediaKind: 'audio',
        reference: externalId(connection, 'media-1'),
        mimeType: 'audio/ogg',
      },
    });
    expect(
      normalizeYCloudWebhook(
        inboundEvent({
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: 'one', title: 'One' },
          },
        }),
        connection,
        binding
      )
    ).toMatchObject({ content: { kind: 'choice', id: 'one', title: 'One' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ignores unimplemented event families and groups rather than enabling coexistence', () => {
    expect(
      normalizeYCloudWebhook(
        '{"type":"whatsapp.echo_message.created"}',
        connection,
        binding
      )
    ).toBeNull();
    expect(
      normalizeYCloudWebhook(
        inboundEvent({ groupId: 'group' }),
        connection,
        binding
      )
    ).toBeNull();
    expect(
      normalizeYCloudWebhook(
        inboundEvent({ type: 'location' }),
        connection,
        binding
      )
    ).toMatchObject({
      content: { kind: 'unsupported', contentType: 'location' },
    });
  });
});
