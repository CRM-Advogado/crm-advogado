import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { withDurableConnection, assertDurableLease } from './execution-context';
import type { ExecuteOutbox } from './worker';

const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value)
    throw new Error('invalid_outbox_reference');
  return value;
};

/** One conservative effect unit per accepted inbound event. A completion means
 * the dispatch pipeline returned, never that every external delivery succeeded.
 * Legacy engines retain their existing error logs and eligibility behavior.
 */
export function createMetaOutboxExecutor(db: SupabaseClient): ExecuteOutbox {
  return async (claim, payload) => {
    const { data: event, error: eventError } = await db
      .from('whatsapp_ingress_events')
      .select('account_id,connection_id,phone_number_id,waba_id,owner_user_id')
      .eq('id', claim.event_id)
      .single();
    if (
      eventError ||
      !event ||
      event.account_id !== claim.account_id ||
      event.connection_id !== claim.connection_id
    )
      throw new Error('invalid_outbox_identity');
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('id,account_id,user_id,phone_number_id,waba_id,status')
      .eq('id', claim.connection_id)
      .eq('account_id', claim.account_id)
      .single();
    if (
      configError ||
      !config ||
      config.status !== 'connected' ||
      config.phone_number_id !== event.phone_number_id ||
      config.waba_id !== event.waba_id ||
      config.user_id !== event.owner_user_id
    )
      throw new Error('outbox_connection_revoked');
    await withDurableConnection(
      {
        accountId: claim.account_id,
        connectionId: claim.connection_id,
        phoneNumberId: event.phone_number_id,
        wabaId: event.waba_id,
        deadlineMs: new Date(claim.lease_until).getTime(),
      },
      async () => {
        if (payload.kind === 'status_dispatch') {
          if (!Array.isArray(payload.updates))
            throw new Error('invalid_status_outbox');
          const seen = new Set<string>();
          for (const update of payload.updates) {
            assertDurableLease();
            const item = update as Record<string, unknown>;
            const data = {
              conversation_id: id(item.conversation_id),
              whatsapp_message_id: id(item.whatsapp_message_id),
              status: id(item.status),
            };
            const key = JSON.stringify(data);
            if (seen.has(key)) continue;
            seen.add(key);
            await dispatchWebhookEvent(
              db,
              claim.account_id,
              'message.status_updated',
              data
            );
          }
          return;
        }
        const conversationId = id(payload.conversation_id),
          contactId = id(payload.contact_id);
        const { data: conversation, error: conversationError } = await db
          .from('conversations')
          .select('id,contact_id')
          .eq('id', conversationId)
          .eq('account_id', claim.account_id)
          .eq('contact_id', contactId)
          .single();
        if (conversationError || !conversation)
          throw new Error('outbox_conversation_missing');
        if (
          payload.kind === 'conversation_created' ||
          payload.conversation_created === true
        ) {
          assertDurableLease();
          await dispatchWebhookEvent(
            db,
            claim.account_id,
            'conversation.created',
            { conversation_id: conversationId, contact_id: contactId }
          );
        }
        if (payload.kind === 'conversation_created') return;
        if (payload.kind !== 'inbound_dispatch')
          throw new Error('unsupported_outbox_kind');
        const { data: message, error: messageError } = await db
          .from('messages')
          .select('message_id,content_text,content_type,interactive_reply_id')
          .eq('id', id(payload.message_id))
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'customer')
          .single();
        if (messageError || !message) throw new Error('outbox_message_missing');
        const inboundText = message.content_text ?? '',
          interactiveReplyId = message.interactive_reply_id;
        assertDurableLease();
        const flow = await dispatchInboundToFlows({
          accountId: claim.account_id,
          userId: event.owner_user_id,
          contactId,
          conversationId,
          message: interactiveReplyId
            ? {
                kind: 'interactive_reply',
                reply_id: interactiveReplyId,
                reply_title: inboundText,
                meta_message_id: message.message_id,
              }
            : {
                kind: 'text',
                text: inboundText,
                meta_message_id: message.message_id,
              },
          isFirstInboundMessage: payload.first_inbound === true,
        });
        const triggers: (
          | 'new_contact_created'
          | 'first_inbound_message'
          | 'new_message_received'
          | 'keyword_match'
          | 'interactive_reply'
        )[] = [];
        if (!flow.consumed) {
          triggers.push('new_message_received', 'keyword_match');
          if (interactiveReplyId) triggers.push('interactive_reply');
        }
        if (payload.was_created === true)
          triggers.unshift('new_contact_created');
        if (payload.first_inbound === true)
          triggers.unshift('first_inbound_message');
        for (const triggerType of triggers) {
          assertDurableLease();
          await runAutomationsForTrigger({
            accountId: claim.account_id,
            triggerType,
            contactId,
            context: {
              message_text: inboundText,
              conversation_id: conversationId,
              interactive_reply_id: interactiveReplyId ?? undefined,
            },
          });
        }
        assertDurableLease();
        if (!flow.consumed && !interactiveReplyId && inboundText.trim())
          await dispatchInboundToAiReply({
            accountId: claim.account_id,
            conversationId,
            contactId,
            configOwnerUserId: event.owner_user_id,
          });
        assertDurableLease();
        await dispatchWebhookEvent(db, claim.account_id, 'message.received', {
          conversation_id: conversationId,
          contact_id: contactId,
          whatsapp_message_id: message.message_id,
          content_type: message.content_type,
          text: message.content_text,
        });
      }
    );
  };
}
