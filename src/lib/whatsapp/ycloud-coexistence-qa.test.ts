import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalId,
  messageTarget,
  type ProviderConnection,
} from './providers/domain';
import { normalizeYCloudWebhook } from './providers/ycloud-webhook';

const connection: ProviderConnection = {
  accountId: 'account-a',
  connectionId: 'ycloud-a',
  provider: 'ycloud',
};
const binding = { phoneNumber: '+5511999999999', wabaId: 'waba-a' };
// Shape checked independently against the YCloud SMB message echo examples.
function echo() {
  return {
    id: 'event-echo',
    type: 'whatsapp.smb.message.echoes',
    apiVersion: 'v2',
    createTime: '2026-10-16T12:00:00Z',
    whatsappMessage: {
      id: 'ycloud-resource',
      wamid: 'wamid.original',
      status: 'sent',
      from: binding.phoneNumber,
      to: '+5511888888888',
      wabaId: binding.wabaId,
      type: 'text',
      text: { body: 'synthetic app message' },
    },
  };
}
const normalize = (body: unknown) =>
  normalizeYCloudWebhook(JSON.stringify(body), connection, binding);
afterEach(() => vi.unstubAllGlobals());

describe('independent coexistence echo QA', () => {
  it('classifies an app echo separately from customer inbound and delivery', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = normalize(echo());
    expect(result).toMatchObject({
      kind: 'outbound_echo',
      source: 'business_app',
      from: binding.phoneNumber,
      to: '+5511888888888',
      content: { kind: 'text', text: 'synthetic app message' },
    });
    expect(result?.kind).not.toBe('inbound');
    expect(result?.kind).not.toBe('delivery');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps distinct event, YCloud resource and original WhatsApp IDs', () => {
    const result = normalize(echo());
    expect(result?.event).toEqual(externalId(connection, 'event-echo'));
    expect(result?.message).toEqual(
      externalId(connection, 'ycloud-resource', 'wamid.original')
    );
    expect(messageTarget(result!.message)).toBe('wamid.original');
  });
  it('returns stable identities on replay without claiming durable deduplication', () => {
    expect(normalize(echo())).toEqual(normalize(echo()));
  });
  it.each(['accountId', 'connectionId'] as const)(
    'namespaces the same event ID by %s',
    (field) => {
      const other = normalizeYCloudWebhook(
        JSON.stringify(echo()),
        { ...connection, [field]: 'other' },
        binding
      );
      expect(normalize(echo())?.event).not.toEqual(other?.event);
    }
  );
  it.each(['from', 'wabaId'])(
    'rejects an echo for a different configured %s',
    (field) => {
      const body = echo();
      body.whatsappMessage[field as 'from' | 'wabaId'] =
        field === 'from' ? '+15551234567' : 'other-waba';
      expect(() => normalize(body)).toThrow();
    }
  );
  it('rejects inverted sender and recipient direction', () => {
    const body = echo();
    body.whatsappMessage.from = body.whatsappMessage.to;
    body.whatsappMessage.to = binding.phoneNumber;
    expect(() => normalize(body)).toThrow();
  });
  it.each(['id', 'apiVersion', 'createTime'])(
    'rejects malformed envelope field %s',
    (field) => {
      const body = echo() as Record<string, unknown>;
      body[field] = '';
      expect(() => normalize(body)).toThrow();
    }
  );
  it('marks unsupported content explicitly rather than generating customer input', () => {
    const body = echo();
    body.whatsappMessage.type = 'location';
    expect(normalize(body)).toMatchObject({
      kind: 'outbound_echo',
      content: { kind: 'unsupported', contentType: 'location' },
    });
  });
  it('ignores groups outside the current one-number individual-chat scope', () => {
    const body = {
      ...echo(),
      whatsappMessage: {
        ...echo().whatsappMessage,
        groupId: 'group.synthetic',
      },
    };
    expect(normalize(body)).toBeNull();
  });
  it('normalizes image metadata without downloading or forwarding credentials', () => {
    const body = {
      ...echo(),
      whatsappMessage: {
        ...echo().whatsappMessage,
        type: 'image',
        image: {
          id: 'media-resource',
          link: 'https://api.ycloud.com/v2/whatsapp/media/download/synthetic',
          mime_type: 'image/jpeg',
        },
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(normalize(body)).toMatchObject({
      kind: 'outbound_echo',
      content: {
        kind: 'media',
        mediaKind: 'image',
        reference: externalId(connection, 'media-resource'),
        mimeType: 'image/jpeg',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not accept an unbound or different provider connection', () => {
    expect(() =>
      normalizeYCloudWebhook(
        JSON.stringify(echo()),
        { ...connection, provider: 'meta_cloud' },
        binding
      )
    ).toThrow();
  });
});

it('preserves the WhatsApp reply target separately from the echoed resource ID', () => {
  const body = {
    ...echo(),
    whatsappMessage: {
      ...echo().whatsappMessage,
      context: { message_id: 'wamid.parent' },
    },
  };
  expect(normalize(body)).toMatchObject({
    kind: 'outbound_echo',
    replyToTransportMessageId: 'wamid.parent',
    message: externalId(connection, 'ycloud-resource', 'wamid.original'),
  });
});
it('never lets a payload choose the authorized account or connection', () => {
  const body = {
    ...echo(),
    accountId: 'attacker-account',
    connectionId: 'attacker-connection',
  };
  expect(normalize(body)?.event).toEqual(externalId(connection, 'event-echo'));
});
it.each(['id', 'wamid', 'type'])(
  'rejects an explicitly empty echo message field %s',
  (field) => {
    const body = echo();
    body.whatsappMessage[field as 'id' | 'wamid' | 'type'] = '';
    expect(() => normalize(body)).toThrow();
  }
);
