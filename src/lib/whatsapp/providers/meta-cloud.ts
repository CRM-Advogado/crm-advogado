import {
  assertSameConnection,
  externalId,
  ProviderError,
  type OutboundMessage,
  type ProviderConnection,
  type ProviderExternalId,
  type TemplateValue,
  type WhatsAppProvider,
} from './domain';

const API = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export interface MetaCloudCredentials {
  phoneNumberId: string;
  accessToken: string;
}

export function createMetaCloudProvider(
  connection: ProviderConnection,
  credentials: MetaCloudCredentials
): WhatsAppProvider {
  externalId(connection, 'validate-connection');
  if (connection.provider !== 'meta_cloud')
    throw new Error('Meta adapter requires a Meta connection');
  if (!credentials.phoneNumberId?.trim() || !credentials.accessToken?.trim())
    throw new Error('Meta connection credentials are incomplete');
  // Snapshot identity and credentials: mutation by a caller must not retarget this instance.
  const identity = Object.freeze({ ...connection });
  const { phoneNumberId, accessToken } = credentials;
  const capabilities = Object.freeze({
    messages: Object.freeze([
      'text',
      'media',
      'template',
      'buttons',
      'list',
      'reaction',
    ] as const),
    mediaDownload: true,
    templateManagement: false,
    onboarding: false,
    maxButtons: 3,
    maxListRows: 10,
    maxMediaDownloadBytes: MAX_MEDIA_BYTES,
  });

  function fail(
    operation: string,
    code: string,
    outcome: 'rejected' | 'retryable' | 'uncertain',
    status?: number
  ): ProviderError {
    return new ProviderError(
      `Meta ${operation} failed (${code})`,
      identity,
      operation,
      code,
      outcome,
      status
    );
  }

  async function request(
    url: string,
    operation: string,
    body?: unknown
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw fail(
        operation,
        'transport_error',
        body === undefined ? 'retryable' : 'uncertain'
      );
    }
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const data = await response.json();
        if (typeof data?.error?.code === 'number')
          code = String(data.error.code);
      } catch {
        /* Status still determines a useful classification. */
      }
      const outcome =
        response.status === 429
          ? 'retryable'
          : response.status >= 500
            ? body === undefined
              ? 'retryable'
              : 'uncertain'
            : 'rejected';
      throw fail(operation, code, outcome, response.status);
    }
    return response;
  }

  function templateValue(value: TemplateValue): unknown {
    if (value.kind === 'text') return { type: 'text', text: value.value };
    if (value.kind === 'payload')
      return { type: 'payload', payload: value.value };
    if (value.kind === 'coupon')
      return { type: 'coupon_code', coupon_code: value.value };
    if (value.kind !== 'media') throw new Error('Unsupported template value');
    if (value.reference) assertSameConnection(identity, value.reference);
    return {
      type: value.mediaKind,
      [value.mediaKind]: value.reference
        ? { id: value.reference.value }
        : { link: value.url },
    };
  }

  function payload(message: OutboundMessage): Record<string, unknown> {
    if (!message.to?.trim())
      throw fail('send', 'invalid_recipient', 'rejected');
    if (message.replyTo) assertSameConnection(identity, message.replyTo);
    const base: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
    };
    if (message.replyTo) base.context = { message_id: message.replyTo.value };
    switch (message.kind) {
      case 'text':
        return { ...base, type: 'text', text: { body: message.text } };
      case 'media': {
        if (!message.url) throw fail('send', 'invalid_media', 'rejected');
        const media: Record<string, unknown> = { link: message.url };
        if (message.caption && message.mediaKind !== 'audio')
          media.caption = message.caption;
        if (message.filename && message.mediaKind === 'document')
          media.filename = message.filename;
        return { ...base, type: message.mediaKind, [message.mediaKind]: media };
      }
      case 'template':
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
                    parameters: slot.values.map(templateValue),
                  })),
                }
              : {}),
          },
        };
      case 'buttons':
      case 'list': {
        const rowCount =
          message.kind === 'list'
            ? message.sections.reduce(
                (sum, section) => sum + section.rows.length,
                0
              )
            : 0;
        if (
          message.body.length > 1024 ||
          !message.body ||
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
            (rowCount < 1 ||
              rowCount > 10 ||
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
        ) {
          throw fail('send', 'invalid_interactive', 'rejected');
        }
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
          reaction: { message_id: message.target.value, emoji: message.emoji },
        };
      default:
        throw fail('send', 'unsupported_message', 'rejected');
    }
  }

  return Object.freeze({
    connection: identity,
    capabilities,
    messaging: Object.freeze({
      async send(message: OutboundMessage) {
        const body = payload(message); // Validate before any request.
        const response = await request(
          `${API}/${encodeURIComponent(phoneNumberId)}/messages`,
          'send',
          body
        );
        try {
          const data = await response.json();
          if (
            typeof data?.messages?.[0]?.id !== 'string' ||
            !data.messages[0].id.trim()
          )
            throw new Error('missing id');
          return externalId(identity, data.messages[0].id);
        } catch {
          throw fail('send', 'invalid_response', 'uncertain', response.status);
        }
      },
    }),
    media: Object.freeze({
      async retrieve(reference: ProviderExternalId) {
        assertSameConnection(identity, reference);
        const response = await request(
          `${API}/${encodeURIComponent(reference.value)}`,
          'media'
        );
        let metadata: { url?: unknown; mime_type?: unknown };
        try {
          metadata = await response.json();
        } catch {
          throw fail('media', 'invalid_response', 'retryable', response.status);
        }
        let url: URL;
        try {
          url = new URL(String(metadata.url));
        } catch {
          throw fail('media', 'invalid_response', 'rejected');
        }
        // The authenticated download URL is external input; never forward the token to another host.
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !(
            url.hostname === 'lookaside.fbsbx.com' ||
            url.hostname.endsWith('.fbcdn.net')
          )
        )
          throw fail('media', 'invalid_download_url', 'rejected');
        const download = await request(url.toString(), 'media');
        if (Number(download.headers.get('content-length')) > MAX_MEDIA_BYTES) {
          await download.body?.cancel();
          throw fail('media', 'media_too_large', 'rejected');
        }
        try {
          const reader = download.body?.getReader();
          if (!reader) throw fail('media', 'invalid_response', 'retryable');
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_MEDIA_BYTES) {
              await reader.cancel();
              throw fail('media', 'media_too_large', 'rejected');
            }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return {
            bytes,
            contentType:
              download.headers.get('content-type') ||
              'application/octet-stream',
          };
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw fail('media', 'transport_error', 'retryable');
        }
      },
    }),
  } satisfies WhatsAppProvider);
}
