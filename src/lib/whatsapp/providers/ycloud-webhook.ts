import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  externalId,
  type InboundContent,
  type NormalizedProviderEvent,
  type ProviderConnection,
} from './domain';
import { isYCloudE164 } from './ycloud';

/** Authenticates bytes only. It does not persist, deduplicate or acknowledge an
 * event and must not be used as an HTTP receiver until durable ingress exists.
 * The signing secret is the webhook endpoint secret, not the API key.
 */
export function verifyYCloudWebhookSignature(
  rawBody: string | Uint8Array,
  header: string | null,
  secret: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {}
): boolean {
  if (!secret?.trim() || !header || typeof header !== 'string') return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0
  )
    return false;
  const parts = header.split(',').map((part) => part.trim());
  if (parts.length !== 2) return false;
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of parts) {
    if (/^t=\d+$/.test(part) && timestamp === undefined)
      timestamp = part.slice(2);
    else if (/^s=[a-fA-F0-9]{64}$/.test(part) && signature === undefined)
      signature = part.slice(2);
    else return false;
  }
  if (
    !timestamp ||
    !signature ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now - Number(timestamp)) > tolerance
  )
    return false;
  try {
    const expected = createHmac('sha256', secret)
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

export interface YCloudWebhookBinding {
  phoneNumber: string;
  wabaId: string;
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid YCloud webhook object');
  return value as ObjectValue;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid YCloud webhook field');
  return value;
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}
function isRfc3339(value: string): boolean {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(
      value
    );
  if (!parts) return false;
  const [
    ,
    yearPart,
    monthPart,
    dayPart,
    hourPart,
    minutePart,
    secondPart,
    offsetHourPart,
    offsetMinutePart,
  ] = parts;
  const year = Number(yearPart),
    month = Number(monthPart),
    day = Number(dayPart);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    Number(hourPart) <= 23 &&
    Number(minutePart) <= 59 &&
    Number(secondPart) <= 59 &&
    Number(offsetHourPart ?? 0) <= 23 &&
    Number(offsetMinutePart ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}
function mediaContent(
  connection: ProviderConnection,
  kind: 'image' | 'video' | 'audio' | 'document',
  data: ObjectValue
): InboundContent {
  const media = object(data[kind]);
  const id = optionalString(media.id);
  const url = optionalString(media.link);
  if (!id && !url) throw new Error('Invalid YCloud inbound media');
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid YCloud inbound media URL');
    }
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Invalid YCloud inbound media URL');
  }
  // Metadata only. No request is made and no API key is forwarded to this URL.
  return {
    kind: 'media',
    mediaKind: kind,
    reference: id ? externalId(connection, id) : undefined,
    url,
    caption: optionalString(media.caption),
    filename: optionalString(media.filename),
    mimeType: optionalString(media.mime_type),
  };
}
function inboundContent(
  connection: ProviderConnection,
  data: ObjectValue
): InboundContent {
  const type = requiredString(data.type);
  switch (type) {
    case 'text':
      return { kind: 'text', text: requiredString(object(data.text).body) };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return mediaContent(connection, type, data);
    case 'interactive': {
      const interactive = object(data.interactive);
      if (!['button_reply', 'list_reply'].includes(String(interactive.type)))
        return { kind: 'unsupported', contentType: type };
      const reply = object(interactive[String(interactive.type)]);
      return {
        kind: 'choice',
        id: requiredString(reply.id),
        title: requiredString(reply.title),
        description: optionalString(reply.description),
      };
    }
    case 'button': {
      const button = object(data.button);
      return {
        kind: 'choice',
        id: requiredString(button.payload),
        title: requiredString(button.text),
      };
    }
    case 'reaction': {
      const reaction = object(data.reaction);
      return {
        kind: 'reaction',
        targetTransportMessageId: requiredString(reaction.message_id),
        emoji:
          reaction.emoji === undefined || reaction.emoji === ''
            ? ''
            : requiredString(reaction.emoji),
      };
    }
    default:
      return { kind: 'unsupported', contentType: type };
  }
}

/** Pure fixture normalizer for an ALREADY AUTHENTICATED payload. The connection
 * and number/WABA binding must come from server configuration, never the JSON.
 * Unknown event types return null; malformed known events or binding conflicts
 * throw. There is intentionally no database, HTTP route or runtime registration.
 */
export function normalizeYCloudWebhook(
  rawBody: string,
  connection: ProviderConnection,
  binding: YCloudWebhookBinding
): NormalizedProviderEvent | null {
  externalId(connection, 'validate-connection');
  if (
    connection.provider !== 'ycloud' ||
    !isYCloudE164(binding.phoneNumber) ||
    !binding.wabaId?.trim()
  )
    throw new Error('Invalid YCloud webhook binding');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Invalid YCloud webhook JSON');
  }
  const envelope = object(parsed);
  const type = requiredString(envelope.type);
  if (
    !['whatsapp.message.updated', 'whatsapp.inbound_message.received'].includes(
      type
    )
  )
    return null;
  const event = externalId(connection, requiredString(envelope.id));
  const occurredAt = requiredString(envelope.createTime);
  if (envelope.apiVersion !== 'v2' || !isRfc3339(occurredAt))
    throw new Error('Invalid YCloud webhook envelope');
  const inbound = type === 'whatsapp.inbound_message.received';
  const data = object(
    inbound ? envelope.whatsappInboundMessage : envelope.whatsappMessage
  );
  const from = requiredString(data.from);
  const to = requiredString(data.to);
  if (
    !isYCloudE164(from) ||
    !isYCloudE164(to) ||
    data.wabaId !== binding.wabaId ||
    (inbound ? to : from) !== binding.phoneNumber
  )
    throw new Error('YCloud webhook does not match the configured connection');
  const message = externalId(
    connection,
    requiredString(data.id),
    optionalString(data.wamid)
  );
  if (inbound) {
    if (data.groupId !== undefined) return null; // Individual chats only in this product phase.
    return {
      kind: 'inbound',
      event,
      occurredAt,
      message,
      from,
      to,
      content: inboundContent(connection, data),
    };
  }
  const status = requiredString(data.status);
  if (!['accepted', 'sent', 'delivered', 'read', 'failed'].includes(status))
    throw new Error('Unsupported YCloud delivery status');
  return {
    kind: 'delivery',
    event,
    occurredAt,
    message,
    status: status as 'accepted' | 'sent' | 'delivered' | 'read' | 'failed',
  };
}
