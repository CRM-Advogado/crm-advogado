import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeStatus } from '../template-status-normalize';

export const MAX_INGRESS_BYTES = 1_048_576;
/** Bounded while streaming, including requests without Content-Length. */
export async function readDurableMetaBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > MAX_INGRESS_BYTES)
    throw new IngressError(413, 'webhook_too_large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_INGRESS_BYTES) {
      await reader.cancel();
      throw new IngressError(413, 'webhook_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    throw new IngressError(400, 'invalid_webhook_encoding');
  }
}
export class IngressError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
    this.name = 'IngressError';
  }
}
type ObjectValue = Record<string, unknown>;
export interface IngressItem {
  account_id: string;
  connection_id: string;
  phone_number_id: string;
  waba_id: string | null;
  event_key: string;
  event_kind: string;
  payload: ObjectValue;
}
interface Config {
  id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  status: string;
}
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IngressError(400, 'invalid_webhook_structure');
  return value as ObjectValue;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new IngressError(400, 'invalid_webhook_field');
  return value;
};
const optionalText = (value: unknown): string | null =>
  value === undefined || value === null ? null : text(value);
const key = (...values: unknown[]) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');
function timestamp(value: unknown): string {
  const seconds = text(value);
  if (!/^\d+$/.test(seconds))
    throw new IngressError(400, 'invalid_webhook_timestamp');
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime()))
    throw new IngressError(400, 'invalid_webhook_timestamp');
  return date.toISOString();
}
function canonicalMessage(
  message: ObjectValue,
  contacts: ObjectValue[]
): ObjectValue {
  const messageId = text(message.id),
    phone = text(message.from).replace(/\D/g, ''),
    type = text(message.type);
  if (!/^[0-9]{5,15}$/.test(phone) || !/^[a-z_]{1,50}$/.test(type))
    throw new IngressError(400, 'invalid_webhook_sender_or_type');
  const person = contacts.find(
    (contact) =>
      typeof contact.wa_id === 'string' &&
      contact.wa_id.replace(/\D/g, '') === phone
  );
  const name = person?.profile
    ? optionalText(record(person.profile).name)
    : null;
  const payload: ObjectValue = {
    message_id: messageId,
    phone,
    name,
    occurred_at: timestamp(message.timestamp),
    content_type: type,
    content_text: null,
    media_url: null,
    interactive_reply_id: null,
    reply_to_provider_id: null,
  };
  if (message.context)
    payload.reply_to_provider_id = optionalText(record(message.context).id);
  if (message.referral) {
    const referral = record(message.referral);
    payload.referral = Object.fromEntries(
      ['source_id', 'source_type', 'source_url', 'headline', 'ctwa_clid'].map(
        (field) => [field, optionalText(referral[field])]
      )
    );
  }
  if (type === 'reaction') {
    const reaction = record(message.reaction);
    payload.reaction_target_id = text(reaction.message_id);
    payload.emoji =
      reaction.emoji === undefined || reaction.emoji === ''
        ? ''
        : text(reaction.emoji);
    return payload;
  }
  if (type === 'text')
    payload.content_text = message.text
      ? optionalText(record(message.text).body)
      : null;
  else if (['image', 'video', 'document', 'audio', 'sticker'].includes(type)) {
    const media = record(message[type]);
    payload.media_url = `/api/whatsapp/media/${encodeURIComponent(text(media.id))}`;
    payload.content_text =
      optionalText(media.caption) ??
      (type === 'document' ? optionalText(media.filename) : null);
    payload.content_type = type === 'sticker' ? 'image' : type;
  } else if (type === 'location') {
    const location = record(message.location);
    if (
      typeof location.latitude !== 'number' ||
      typeof location.longitude !== 'number' ||
      !Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude)
    )
      throw new IngressError(400, 'invalid_location');
    payload.content_text = [
      optionalText(location.name),
      optionalText(location.address),
      `${location.latitude},${location.longitude}`,
    ]
      .filter(Boolean)
      .join(' - ');
  } else if (type === 'interactive') {
    const interactive = record(message.interactive);
    const reply = interactive.button_reply ?? interactive.list_reply;
    if (reply) {
      const chosen = record(reply);
      payload.interactive_reply_id = text(chosen.id);
      payload.content_text = optionalText(chosen.title) ?? chosen.id;
    } else payload.content_text = '[Interactive reply]';
  } else {
    payload.content_type = 'text';
    payload.content_text = `[Unsupported message type: ${type}]`;
  }
  return payload;
}

/** Only authenticated input is accepted here. Prepare all items before the one
 * enqueue transaction; never fall back to the legacy after-ACK path on failure.
 */
export async function prepareMetaIngress(
  db: SupabaseClient,
  body: unknown
): Promise<{ items: IngressItem[]; ignored: number }> {
  const root = record(body);
  if (!Array.isArray(root.entry) || root.entry.length > 200)
    throw new IngressError(400, 'invalid_webhook_entries');
  const items: IngressItem[] = [];
  let ignored = 0;
  const receiptId = randomUUID();
  for (const rawEntry of root.entry) {
    const entry = record(rawEntry),
      wabaId = text(entry.id);
    if (!Array.isArray(entry.changes))
      throw new IngressError(400, 'invalid_webhook_changes');
    for (const rawChange of entry.changes) {
      const change = record(rawChange),
        field = text(change.field),
        value = record(change.value);
      const template = [
        'message_template_status_update',
        'message_template_quality_update',
        'message_template_components_update',
      ].includes(field);
      if (!template && field !== 'messages') {
        ignored++;
        continue;
      }
      let query = db
        .from('whatsapp_config')
        .select('id,account_id,phone_number_id,waba_id,status');
      if (template) query = query.eq('waba_id', wabaId);
      else
        query = query.eq(
          'phone_number_id',
          text(record(value.metadata).phone_number_id)
        );
      const { data, error } = await query;
      if (error) throw new IngressError(503, 'connection_lookup_failed');
      const configs = (data ?? []) as Config[];
      if (
        !configs.length ||
        (!template && configs.length !== 1) ||
        configs.some(
          (config) =>
            config.status !== 'connected' ||
            (config.waba_id !== null && config.waba_id !== wabaId)
        )
      )
        throw new IngressError(409, 'connection_not_authorized');
      const add = (
        config: Config,
        kind: string,
        eventKey: string,
        payload: ObjectValue
      ) => {
        items.push({
          account_id: config.account_id,
          connection_id: config.id,
          phone_number_id: config.phone_number_id,
          waba_id: config.waba_id,
          event_kind: kind,
          event_key: eventKey,
          payload,
        });
        if (items.length > 200)
          throw new IngressError(413, 'webhook_batch_too_large');
      };
      if (template) {
        const templateId =
          typeof value.message_template_id === 'number'
            ? String(value.message_template_id)
            : text(value.message_template_id);
        const kind =
          field === 'message_template_status_update'
            ? 'template_status'
            : field === 'message_template_quality_update'
              ? 'template_quality'
              : 'template_components';
        const payload: ObjectValue = { template_id: templateId };
        if (kind === 'template_status') {
          payload.status = normalizeStatus(text(value.event));
          payload.reason =
            payload.status === 'REJECTED'
              ? (optionalText(value.reason) ?? 'Rejected by Meta')
              : null;
        }
        if (kind === 'template_quality') {
          const quality = optionalText(value.new_quality_score)?.toUpperCase();
          payload.quality =
            quality && ['GREEN', 'YELLOW', 'RED'].includes(quality)
              ? quality
              : null;
        }
        const sourceTime =
          typeof entry.time === 'number' || typeof entry.time === 'string'
            ? entry.time
            : receiptId;
        for (const config of configs)
          add(
            config,
            kind,
            key(kind, templateId, sourceTime, payload),
            payload
          );
        continue;
      }
      const config = configs[0];
      const contacts =
        value.contacts === undefined
          ? []
          : Array.isArray(value.contacts)
            ? value.contacts.map(record)
            : null;
      if (!contacts) throw new IngressError(400, 'invalid_webhook_contacts');
      for (const rawMessage of value.messages === undefined
        ? []
        : Array.isArray(value.messages)
          ? value.messages
          : [null]) {
        const message = record(rawMessage),
          payload = canonicalMessage(message, contacts),
          kind = message.type === 'reaction' ? 'reaction' : 'message';
        add(config, kind, key(kind, payload.message_id), payload);
      }
      for (const rawStatus of value.statuses === undefined
        ? []
        : Array.isArray(value.statuses)
          ? value.statuses
          : [null]) {
        const status = record(rawStatus),
          state = text(status.status);
        if (!['sent', 'delivered', 'read', 'failed'].includes(state)) {
          ignored++;
          continue;
        }
        const payload = {
          message_id: text(status.id),
          status: state,
          occurred_at: timestamp(status.timestamp),
        };
        add(
          config,
          'status',
          key(
            'status',
            payload.message_id,
            state,
            payload.occurred_at,
            optionalText(status.recipient_id)
          ),
          payload
        );
      }
    }
  }
  return { items, ignored };
}

export async function acceptMetaIngress(db: SupabaseClient, body: unknown) {
  const prepared = await prepareMetaIngress(db, body);
  const { data, error } = await db.rpc('enqueue_whatsapp_ingress', {
    p_events: prepared.items,
  });
  if (error) throw new IngressError(503, 'durable_acceptance_failed');
  return {
    accepted: prepared.items.length,
    ignored: prepared.ignored,
    ...(data as { inserted: number; received: number }),
  };
}
