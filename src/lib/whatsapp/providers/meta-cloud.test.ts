import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';
import * as legacy from '../meta-api';
import {
  externalId,
  type OutboundMessage,
  type ProviderConnection,
} from './domain';
import { createMetaCloudProvider } from './meta-cloud';
import { resolveLegacyMetaProvider } from './legacy-meta-connection';
import { toTemplateMessage } from './legacy-template';
import { sendOutbound } from './send-outbound';

const connection: ProviderConnection = {
  accountId: 'account',
  connectionId: 'config',
  provider: 'meta_cloud',
};
const credentials = { phoneNumberId: 'phone', accessToken: 'dummy-token' };
const common = { ...credentials, to: '5511999999999' };
afterEach(() => vi.unstubAllGlobals());

describe('Meta adapter substitution preserves existing wire messages', () => {
  const cases: {
    name: string;
    message: OutboundMessage;
    old: () => Promise<unknown>;
  }[] = [
    {
      name: 'text with reply',
      message: {
        kind: 'text',
        to: common.to,
        text: 'Hello',
        replyTo: externalId(connection, 'quoted'),
      },
      old: () =>
        legacy.sendTextMessage({
          ...common,
          text: 'Hello',
          contextMessageId: 'quoted',
        }),
    },
    {
      name: 'audio omits caption and filename',
      message: {
        kind: 'media',
        to: common.to,
        mediaKind: 'audio',
        url: 'https://example.com/audio',
        caption: 'ignored',
        filename: 'ignored',
      },
      old: () =>
        legacy.sendMediaMessage({
          ...common,
          kind: 'audio',
          link: 'https://example.com/audio',
          caption: 'ignored',
          filename: 'ignored',
        }),
    },
    {
      name: 'document',
      message: {
        kind: 'media',
        to: common.to,
        mediaKind: 'document',
        url: 'https://example.com/doc',
        caption: 'Contract',
        filename: 'file.pdf',
      },
      old: () =>
        legacy.sendMediaMessage({
          ...common,
          kind: 'document',
          link: 'https://example.com/doc',
          caption: 'Contract',
          filename: 'file.pdf',
        }),
    },
    {
      name: 'buttons',
      message: {
        kind: 'buttons',
        to: common.to,
        body: 'Choose',
        header: 'Header',
        footer: 'Footer',
        buttons: [{ id: 'yes', title: 'Yes' }],
      },
      old: () =>
        legacy.sendInteractiveButtons({
          ...common,
          bodyText: 'Choose',
          headerText: 'Header',
          footerText: 'Footer',
          buttons: [{ id: 'yes', title: 'Yes' }],
        }),
    },
    {
      name: 'list',
      message: {
        kind: 'list',
        to: common.to,
        body: 'Choose',
        buttonLabel: 'Open',
        sections: [
          {
            title: 'Options',
            rows: [{ id: 'one', title: 'One', description: 'First' }],
          },
        ],
      },
      old: () =>
        legacy.sendInteractiveList({
          ...common,
          bodyText: 'Choose',
          buttonLabel: 'Open',
          sections: [
            {
              title: 'Options',
              rows: [{ id: 'one', title: 'One', description: 'First' }],
            },
          ],
        }),
    },
    {
      name: 'reaction removal',
      message: {
        kind: 'reaction',
        to: common.to,
        target: externalId(connection, 'target'),
        emoji: '',
      },
      old: () =>
        legacy.sendReactionMessage({
          ...common,
          targetMessageId: 'target',
          emoji: '',
        }),
    },
  ];
  for (const testCase of cases)
    it(testCase.name, async () => {
      const fetchMock = vi.fn(async () =>
        Response.json({ messages: [{ id: 'wamid' }] })
      );
      vi.stubGlobal('fetch', fetchMock);
      await testCase.old();
      const expected = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      const result = await sendOutbound(
        'account',
        createMetaCloudProvider(connection, credentials),
        testCase.message
      );
      const actual = fetchMock.mock.calls[1] as unknown as [
        string,
        RequestInit,
      ];
      expect(actual[0]).toBe(expected[0]);
      expect(JSON.parse(String(actual[1].body))).toEqual(
        JSON.parse(String(expected[1].body))
      );
      expect(actual[1].headers).toEqual(expected[1].headers);
      expect(result).toEqual(externalId(connection, 'wamid'));
    });

  it('structured templates retain header media, body variables and dynamic buttons', async () => {
    const template: MessageTemplate = {
      id: 'row',
      user_id: 'user',
      name: 'contract',
      category: 'Utility',
      language: 'pt_BR',
      body_text: 'Hello {{1}}',
      header_type: 'document',
      header_media_url: 'https://example.com/doc',
      buttons: [
        {
          type: 'URL',
          text: 'Open',
          url: 'https://example.com/{{1}}',
          example: 'abc',
        },
      ],
      created_at: '2026-01-01T00:00:00Z',
    };
    const args = {
      ...common,
      templateName: 'contract',
      language: 'pt_BR',
      template,
      messageParams: { body: ['Ana'], buttonParams: { 0: 'abc' } },
    };
    const fetchMock = vi.fn(async () =>
      Response.json({ messages: [{ id: 'wamid' }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    await legacy.sendTemplateMessage(args);
    await sendOutbound(
      'account',
      createMetaCloudProvider(connection, credentials),
      toTemplateMessage(connection, args)
    );
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[1][1].body))).toEqual(
      JSON.parse(String(calls[0][1].body))
    );
  });
});

it('legacy config identity cannot be inferred from another account or an unsupported provider', () => {
  const config = {
    id: 'config',
    account_id: 'other',
    phone_number_id: 'phone',
  };
  expect(() =>
    resolveLegacyMetaProvider('account', config, 'dummy-token')
  ).toThrow(/account/);
  expect(() =>
    resolveLegacyMetaProvider(
      'other',
      { ...config, provider: 'ycloud' },
      'dummy-token'
    )
  ).toThrow(/not a Meta/);
});

it('rejects oversized download content before buffering it', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp/file' })
    )
    .mockResolvedValueOnce(
      new Response('small body', {
        headers: { 'content-length': String(26 * 1024 * 1024) },
      })
    );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    createMetaCloudProvider(connection, credentials).media!.retrieve(
      externalId(connection, 'media')
    )
  ).rejects.toMatchObject({ code: 'media_too_large', outcome: 'rejected' });
});
