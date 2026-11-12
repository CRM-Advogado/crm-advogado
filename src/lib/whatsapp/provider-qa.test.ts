import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalId,
  ProviderError,
  type ProviderConnection,
} from './providers/domain';
import { resolveProvider } from './providers/registry';
import { createMetaCloudProvider } from './providers/meta-cloud';

const connection: ProviderConnection = {
  accountId: 'account-a',
  connectionId: 'connection-a',
  provider: 'meta_cloud',
};
const credentials = {
  phoneNumberId: 'phone-a',
  accessToken: 'dummy-provider-token',
};
const message = {
  kind: 'text' as const,
  to: '5511999999999',
  text: 'QA synthetic',
};
afterEach(() => vi.unstubAllGlobals());

describe('provider QA: identity and account authorization', () => {
  it('preserves the full namespace when external values collide', () => {
    const original = externalId(connection, 'same-id');
    for (const change of [
      { accountId: 'account-b' },
      { connectionId: 'connection-b' },
      { provider: 'ycloud' as const },
    ]) {
      expect(externalId({ ...connection, ...change }, 'same-id')).not.toEqual(
        original
      );
    }
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => externalId(connection, '  ')).toThrow();
  });
  it('rejects another account before calling its provider factory', () => {
    const factory = vi.fn();
    expect(() =>
      resolveProvider('account-b', connection, { meta_cloud: factory })
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not fall back to Meta for unavailable providers', () => {
    const factory = vi.fn();
    expect(() =>
      resolveProvider(
        'account-a',
        { ...connection, provider: 'gupshup' },
        { meta_cloud: factory }
      )
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects a factory that returns another connection', () => {
    expect(() =>
      resolveProvider('account-a', connection, {
        meta_cloud: () =>
          createMetaCloudProvider(
            { ...connection, connectionId: 'other' },
            credentials
          ),
      })
    ).toThrow();
  });
});

describe('provider QA: Meta contract and failure semantics', () => {
  it('snapshots credentials and identity and preserves Meta payload/reply IDs', async () => {
    const mutableConnection = { ...connection };
    const mutableCredentials = { ...credentials };
    const provider = createMetaCloudProvider(
      mutableConnection,
      mutableCredentials
    );
    mutableConnection.connectionId = 'retargeted';
    mutableCredentials.accessToken = 'retargeted';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.synthetic' }] }))
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await provider.messaging.send({
        ...message,
        replyTo: externalId(connection, 'parent'),
      })
    ).toEqual({ ...connection, value: 'wamid.synthetic' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/phone-a/messages');
    expect(init.headers.Authorization).toBe(
      `Bearer ${credentials.accessToken}`
    );
    expect(JSON.parse(init.body)).toMatchObject({
      type: 'text',
      context: { message_id: 'parent' },
      text: { body: message.text },
    });
  });
  it.each(['accountId', 'connectionId', 'provider'] as const)(
    'rejects cross-%s references before network',
    async (field) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const other = {
        ...connection,
        [field]: field === 'provider' ? 'ycloud' : 'other',
      } as ProviderConnection;
      await expect(
        createMetaCloudProvider(connection, credentials).messaging.send({
          ...message,
          replyTo: externalId(other, 'parent'),
        })
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'retryable'],
    [500, 'uncertain'],
    [503, 'uncertain'],
  ] as const)(
    'classifies HTTP %s without retry or credential leakage',
    async (status, outcome) => {
      const fetchMock = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: `failure ${credentials.accessToken}`,
                code: 123,
              },
            }),
            { status }
          )
        )
      );
      vi.stubGlobal('fetch', fetchMock);
      const error = await createMetaCloudProvider(connection, credentials)
        .messaging.send(message)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        connection,
        operation: 'send',
        outcome,
        httpStatus: status,
      });
      expect(error.message).not.toContain(credentials.accessToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['not-json', '{}', '{"messages":[{"id":" "}]}'])(
    'keeps malformed successful response uncertain: %s',
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(body));
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        createMetaCloudProvider(connection, credentials).messaging.send(message)
      ).rejects.toMatchObject({
        code: 'invalid_response',
        outcome: 'uncertain',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it('keeps timeout uncertain and does not repeat the send', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createMetaCloudProvider(connection, credentials).messaging.send(message)
    ).rejects.toMatchObject({ code: 'transport_error', outcome: 'uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects provider-hosted media pointing outside the approved host before forwarding credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ url: 'https://attacker.invalid/download' })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createMetaCloudProvider(connection, credentials).media!.retrieve(
        externalId(connection, 'media-a')
      )
    ).rejects.toMatchObject({
      code: 'invalid_download_url',
      outcome: 'rejected',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('rejects redirected media downloads rather than following external targets', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: 'https://lookaside.fbsbx.com/download' })
      )
    )
    .mockImplementationOnce((_url: string, init: RequestInit) => {
      if (init.redirect === 'error')
        return Promise.reject(new TypeError('redirect refused'));
      return Promise.resolve(new Response('synthetic private endpoint'));
    });
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    createMetaCloudProvider(connection, credentials).media!.retrieve(
      externalId(connection, 'media-a')
    )
  ).rejects.toMatchObject({ outcome: 'retryable' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('preserves recipient-rejection code for the legacy phone retry classifier', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 131030, message: 'Recipient rejected' },
        }),
        { status: 400 }
      )
    )
  );
  const { canTryRecipientVariant } = await import('./providers/send-outbound');
  const error = await createMetaCloudProvider(connection, credentials)
    .messaging.send(message)
    .catch((e) => e);
  expect(canTryRecipientVariant(error)).toBe(true);
});

it('runs validation CI for pull requests and pushes to develop and main', async () => {
  const { readFileSync } = await import('node:fs');
  // js-yaml ships transitively with the repository lint toolchain.
  const { createRequire } = await import('node:module');
  const yaml = createRequire(import.meta.url)('js-yaml') as {
    load(input: string): { on: Record<string, { branches: string[] }> };
  };
  const workflow = yaml.load(
    readFileSync(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8'
    )
  );
  for (const event of ['pull_request', 'push']) {
    expect(workflow.on[event].branches).toEqual(
      expect.arrayContaining(['develop', 'main'])
    );
  }
});

it('substitutes a YCloud-shaped fake port without calling Meta and enforces capabilities first', async () => {
  const { sendOutbound } = await import('./providers/send-outbound');
  const identity = { ...connection, provider: 'ycloud' as const };
  const send = vi
    .fn()
    .mockResolvedValue(externalId(identity, 'ycloud-message'));
  const provider = {
    connection: identity,
    capabilities: {
      messages: ['text'] as const,
      mediaDownload: false,
      templateManagement: false,
      onboarding: false,
      maxButtons: 0,
      maxListRows: 0,
    },
    messaging: { send },
  };
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(await sendOutbound('account-a', provider, message)).toEqual(
    externalId(identity, 'ycloud-message')
  );
  await expect(sendOutbound('account-b', provider, message)).rejects.toThrow();
  await expect(
    sendOutbound('account-a', provider, {
      kind: 'media',
      to: message.to,
      mediaKind: 'image',
      url: 'https://example.invalid/a.png',
    })
  ).rejects.toMatchObject({ code: 'unsupported_message' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('marks a successful adapter returning another connection as uncertain without retry', async () => {
  const { sendOutbound } = await import('./providers/send-outbound');
  const send = vi
    .fn()
    .mockResolvedValue(
      externalId({ ...connection, connectionId: 'other' }, 'message')
    );
  const provider = {
    ...createMetaCloudProvider(connection, credentials),
    messaging: { send },
  };
  await expect(
    sendOutbound('account-a', provider, message)
  ).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([
  [500, 'uncertain'],
  [429, 'retryable'],
] as const)(
  'does not authorize phone-variant resend for HTTP %s containing recipient code',
  async (status, outcome) => {
    const { canTryRecipientVariant } =
      await import('./providers/send-outbound');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 131030, message: 'Recipient rejected' },
        }),
        { status }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await createMetaCloudProvider(connection, credentials)
      .messaging.send(message)
      .catch((e) => e);
    expect(error).toMatchObject({ outcome });
    expect(canTryRecipientVariant(error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);

it.each([500, 429])(
  'does not repeat the actual conversation send on HTTP %s and code 131030',
  async (status) => {
    const { encrypt } = await import('./encryption');
    const { sendMessageToConversation } = await import('./send-message');
    const db = {
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          single: async () => ({
            data:
              table === 'conversations'
                ? {
                    id: 'conv-a',
                    contact: { id: 'contact-a', phone: '5511999999999' },
                  }
                : {
                    id: 'cfg-a',
                    account_id: 'account-a',
                    phone_number_id: 'phone-a',
                    access_token: encrypt('dummy-provider-token'),
                  },
            error: null,
          }),
        };
        return builder;
      },
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 131030, message: 'Recipient rejected' },
          }),
          { status }
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendMessageToConversation(
        db as unknown as Parameters<typeof sendMessageToConversation>[0],
        'account-a',
        {
          conversationId: 'conv-a',
          messageType: 'text',
          contentText: 'synthetic',
        }
      )
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);
