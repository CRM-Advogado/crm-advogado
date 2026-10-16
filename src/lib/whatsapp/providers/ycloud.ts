import {
  assertSameConnection,
  externalId,
  messageTarget,
  ProviderError,
  type OutboundMessage,
  type ProviderConnection,
  type TemplateValue,
  type WhatsAppProvider,
} from './domain';

const SEND_URL = 'https://api.ycloud.com/v2/whatsapp/messages/sendDirectly';
const TIMEOUT_MS = 15_000;
export const isYCloudE164 = (value: unknown): value is string =>
  typeof value === 'string' && /^\+[1-9]\d{1,14}$/.test(value);

export interface YCloudCredentials {
  apiKey: string;
  from: string;
}

/** Standalone adapter. It is deliberately not registered in the legacy DB
 * resolver: choosing/authorizing a YCloud connection is separate product work.
 * Official wire contracts: YCloud-Developers/ycloud-sdk-node models and API v2.
 */
export function createYCloudProvider(
  connection: ProviderConnection,
  credentials: YCloudCredentials
): WhatsAppProvider {
  externalId(connection, 'validate-connection');
  if (connection.provider !== 'ycloud')
    throw new Error('YCloud adapter requires a YCloud connection');
  if (!credentials.apiKey?.trim() || !isYCloudE164(credentials.from))
    throw new Error('YCloud connection credentials are incomplete');
  const identity = Object.freeze({
    accountId: connection.accountId,
    connectionId: connection.connectionId,
    provider: connection.provider,
  });
  const { apiKey, from } = credentials;
  const capabilities = Object.freeze({
    messages: Object.freeze([
      'text',
      'media',
      'template',
      'buttons',
      'list',
      'reaction',
    ] as const),
    mediaDownload: false,
    templateManagement: false,
    onboarding: false,
    maxButtons: 3,
    maxListRows: 10,
  });

  function fail(
    code: string,
    outcome: 'rejected' | 'retryable' | 'uncertain',
    status?: number
  ) {
    // Provider error descriptions can contain message content or secrets.
    return new ProviderError(
      `YCloud send failed (${code})`,
      identity,
      'send',
      code,
      outcome,
      status
    );
  }
  function parameter(value: TemplateValue): unknown {
    switch (value.kind) {
      case 'text':
        return { type: 'text', text: value.value };
      case 'payload':
        return { type: 'payload', payload: value.value };
      case 'coupon':
        return { type: 'coupon_code', coupon_code: value.value };
      case 'media':
        if (value.reference) assertSameConnection(identity, value.reference);
        if (!value.reference && !value.url)
          throw fail('invalid_template_media', 'rejected');
        return {
          type: value.mediaKind,
          [value.mediaKind]: value.reference
            ? { id: value.reference.value }
            : { link: value.url },
        };
    }
  }
  function payload(message: OutboundMessage): Record<string, unknown> {
    if (!isYCloudE164(message.to)) throw fail('invalid_recipient', 'rejected');
    const base: Record<string, unknown> = { from, to: message.to };
    if (message.replyTo) {
      assertSameConnection(identity, message.replyTo);
      base.context = { message_id: messageTarget(message.replyTo) };
    }
    switch (message.kind) {
      case 'text':
        if (!message.text) throw fail('invalid_text', 'rejected');
        return { ...base, type: 'text', text: { body: message.text } };
      case 'media': {
        let url: URL;
        try {
          url = new URL(message.url);
        } catch {
          throw fail('invalid_media', 'rejected');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw fail('invalid_media', 'rejected');
        const media: Record<string, unknown> = { link: message.url };
        if (message.caption && message.mediaKind !== 'audio')
          media.caption = message.caption;
        if (message.filename && message.mediaKind === 'document')
          media.filename = message.filename;
        return { ...base, type: message.mediaKind, [message.mediaKind]: media };
      }
      case 'template':
        if (!message.name || !message.language)
          throw fail('invalid_template', 'rejected');
        return {
          ...base,
          type: 'template',
          template: {
            name: message.name,
            language: { code: message.language },
            ...(message.slots.length
              ? {
                  components: message.slots.map((slot) => ({
                    type: slot.location,
                    ...(slot.location === 'button'
                      ? { sub_type: slot.action, index: String(slot.index) }
                      : {}),
                    parameters: slot.values.map(parameter),
                  })),
                }
              : {}),
          },
        };
      case 'buttons':
      case 'list': {
        const rows =
          message.kind === 'list'
            ? message.sections.reduce(
                (sum, section) => sum + section.rows.length,
                0
              )
            : 0;
        if (
          !message.body ||
          message.body.length > 1024 ||
          (message.header?.length ?? 0) > 60 ||
          (message.footer?.length ?? 0) > 60 ||
          (message.kind === 'buttons' &&
            (message.buttons.length < 1 ||
              message.buttons.length > 3 ||
              message.buttons.some(
                (b) =>
                  !b.id || b.id.length > 256 || !b.title || b.title.length > 20
              ))) ||
          (message.kind === 'list' &&
            (rows < 1 ||
              rows > 10 ||
              !message.buttonLabel ||
              message.buttonLabel.length > 20 ||
              message.sections.length > 10 ||
              message.sections.some(
                (s) =>
                  !s.rows.length ||
                  (s.title?.length ?? 0) > 24 ||
                  s.rows.some(
                    (r) =>
                      !r.id ||
                      r.id.length > 200 ||
                      !r.title ||
                      r.title.length > 24 ||
                      (r.description?.length ?? 0) > 72
                  )
              )))
        )
          throw fail('invalid_interactive', 'rejected');
        return {
          ...base,
          type: 'interactive',
          interactive: {
            type: message.kind === 'buttons' ? 'button' : 'list',
            body: { text: message.body },
            ...(message.header
              ? { header: { type: 'text', text: message.header } }
              : {}),
            ...(message.footer ? { footer: { text: message.footer } } : {}),
            action:
              message.kind === 'buttons'
                ? {
                    buttons: message.buttons.map((button) => ({
                      type: 'reply',
                      reply: button,
                    })),
                  }
                : { button: message.buttonLabel, sections: message.sections },
          },
        };
      }
      case 'reaction':
        assertSameConnection(identity, message.target);
        return {
          ...base,
          type: 'reaction',
          reaction: {
            message_id: messageTarget(message.target),
            emoji: message.emoji,
          },
        };
      default:
        throw fail('unsupported_message', 'rejected');
    }
  }

  return Object.freeze({
    connection: identity,
    capabilities,
    messaging: Object.freeze({
      async send(message: OutboundMessage) {
        const body = payload(message);
        let response: Response;
        try {
          response = await fetch(SEND_URL, {
            method: 'POST',
            headers: {
              'X-API-Key': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: 'no-store',
            redirect: 'error',
          });
        } catch {
          throw fail('transport_error', 'uncertain');
        }
        if (!response.ok) {
          throw fail(
            `http_${response.status}`,
            response.status === 429
              ? 'retryable'
              : response.status >= 500
                ? 'uncertain'
                : 'rejected',
            response.status
          );
        }
        let data: Record<string, unknown>;
        try {
          data = await response.json();
          if (
            !data ||
            typeof data.id !== 'string' ||
            !data.id.trim() ||
            (data.wamid !== undefined &&
              (typeof data.wamid !== 'string' || !data.wamid.trim())) ||
            (data.from !== undefined && data.from !== from) ||
            (data.to !== undefined && data.to !== message.to)
          )
            throw new Error('invalid response');
        } catch {
          throw fail('invalid_response', 'uncertain', response.status);
        }
        if (data.status === 'failed')
          throw fail('provider_rejected', 'rejected', response.status);
        return externalId(
          identity,
          data.id as string,
          data.wamid as string | undefined
        );
      },
    }),
  });
}
